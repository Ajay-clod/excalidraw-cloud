/**
 * Pure-Yjs collaboration layer for Excalidraw.
 *
 * - Yjs is the single source of truth for the scene.
 * - Excalidraw local changes are periodically written as full-scene snapshots.
 * - Remote Yjs updates are applied safely, with a queue while the user is drawing.
 * - Cursors / presence use Yjs awareness (no portal / WS scene broadcast).
 * - Firebase is still used for persistence (save/load by room).
 */

import {
  CaptureUpdateAction,
  getSceneVersion,
  restoreElements,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { APP_NAME, EVENT } from "@excalidraw/common";
import {
  IDLE_THRESHOLD,
  ACTIVE_THRESHOLD,
  UserIdleState,
  isDevEnv,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  throttleRAF,
} from "@excalidraw/common";
import { getVisibleSceneBounds } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element";
import { isImageElement, isInitializedImageElement } from "@excalidraw/element";
import { AbortError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";
import { withBatchedUpdates } from "@excalidraw/excalidraw/reactUtils";

import throttle from "lodash.throttle";
import { PureComponent } from "react";

import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  SocketId,
  Collaborator,
  Gesture,
} from "@excalidraw/excalidraw/types";
import type { Mutable } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  SYNC_FULL_SCENE_INTERVAL_MS,
} from "../app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getSyncableElements,
} from "../data";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../data/FileManager";
import { LocalData } from "../data/LocalData";
import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "../data/firebase";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import { resetBrowserStateVersions } from "../data/tabSync";

import { collabErrorIndicatorAtom } from "./CollabError";
import Portal from "./Portal";

import YjsProvider from "./YjsProvider";

import type {
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";

/* === YjsProvider import === */

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);

interface CollabState {
  errorMessage: string | null;
  /** errors related to saving */
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
  activeRoomLink: string | null;
}

export const activeRoomLinkAtom = atom<string | null>(null);

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
}

interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

type InitialScene =
  | (ImportedDataState & { elements: readonly OrderedExcalidrawElement[] })
  | null;

class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<SocketId, Collaborator>();

  /* === Yjs provider property === */
  private yjsProvider: YjsProvider | null = null;

  // Pointer state (so we know when NOT to apply remote scenes / NOT to write)
  private _localPointerDown: boolean = false;
  private _pointerDownWatchdogId?: number;

  // Remote apply state (Yjs → Excalidraw)
  private _applyingRemote: boolean = false;
  private _pendingRemoteElements: ReadonlyArray<any> | null = null;

  // Initial scene promise (so startCollaboration() resolves when we first get Yjs state)
  private _initialScenePromise?: {
    resolve: (value: InitialScene | Promise<InitialScene>) => void;
    reject: (error: Error) => void;
  };
  private _initialScenePromiseResolved: boolean = false;

  // Throttled writer (to avoid storms)
  private _writeFullSceneThrottled: (() => void) & {
    cancel?: () => void;
    flush?: () => void;
  };

  constructor(props: CollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: null,
    };

    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds);
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        const { savedFiles, erroredFiles } = await saveFilesToFirebase({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });

        return {
          savedFiles: savedFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
          erroredFiles: erroredFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
        };
      },
    });

    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;

    // Throttle writes to 800ms to avoid races and provider batching effects.
    this._writeFullSceneThrottled = throttle(
      () => {
        // call sync write (sync because YjsProvider.writeElements is sync)
        this._writeFullSceneToYjsSafe();
      },
      800,
      { leading: true, trailing: true },
    );
  }

  private onUmmount: (() => void) | null = null;

  // ===== Pointer handlers =====

  private _onPointerDownBound = () => {
    this._localPointerDown = true;

    // watchdog: avoid stuck pointerDown if pointerUp never fires
    if (this._pointerDownWatchdogId) {
      clearTimeout(this._pointerDownWatchdogId);
    }
    this._pointerDownWatchdogId = window.setTimeout(() => {
      if (this._localPointerDown) {
        console.warn(
          "[collab] pointerdown watchdog fired — clearing stuck pointer state",
        );
        this._localPointerDown = false;

        // If there were pending remote elements, apply them now
        if (this._pendingRemoteElements) {
          const queued = this._pendingRemoteElements;
          this._pendingRemoteElements = null;
          this._applyYjsElements(queued);
        }
      }
      this._pointerDownWatchdogId = undefined;
    }, 30000);
  };

  private _onPointerUpBound = () => {
    this._localPointerDown = false;

    // apply any remote Yjs scene that was queued while drawing
    if (this._pendingRemoteElements) {
      const queued = this._pendingRemoteElements;
      this._pendingRemoteElements = null;
      this._applyYjsElements(queued);
    }

    // clear watchdog
    if (this._pointerDownWatchdogId) {
      clearTimeout(this._pointerDownWatchdogId);
      this._pointerDownWatchdogId = undefined;
    }

    // Use throttled writer to avoid write storms; we want a near-immediate flush but
    // not synchronous blocking of UI.
    this._writeFullSceneThrottled();
  };

  private _onPointerCancelBound = () => {
    // treat pointercancel like pointerup
    this._localPointerDown = false;

    if (this._pendingRemoteElements) {
      const queued = this._pendingRemoteElements;
      this._pendingRemoteElements = null;
      this._applyYjsElements(queued);
    }

    if (this._pointerDownWatchdogId) {
      clearTimeout(this._pointerDownWatchdogId);
      this._pointerDownWatchdogId = undefined;
    }

    this._writeFullSceneThrottled();
  };

  private _onWindowBlurBound = () => {
    if (this._localPointerDown) {
      this._onPointerCancelBound();
    }
  };

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    // pointer tracking
    window.addEventListener("pointerdown", this._onPointerDownBound, {
      passive: true,
    });
    window.addEventListener("pointerup", this._onPointerUpBound, {
      passive: true,
    });
    window.addEventListener("pointercancel", this._onPointerCancelBound, {
      passive: true,
    });
    window.addEventListener("pointerleave", this._onPointerCancelBound, {
      passive: true,
    });
    window.addEventListener("blur", this._onWindowBlurBound);

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow(() => {});
    const throttledRelayUserViewportBounds = throttleRAF(
      this.relayVisibleSceneBounds,
    );
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );

    this.onUmmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
    };

    this.onOfflineStatusToggle();
    this.initializeIdleDetector();

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromFirebase: this.fetchImageFilesFromFirebase,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
      getUsername: this.getUsername,
      getActiveRoomLink: this.getActiveRoomLink,
      setCollabError: this.setErrorDialog,
    };

    appJotaiStore.set(collabAPIAtom, collabAPI);

    if (isTestEnv() || isDevEnv()) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  componentWillUnmount() {
    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );

    // pointer handlers
    window.removeEventListener("pointerdown", this._onPointerDownBound);
    window.removeEventListener("pointerup", this._onPointerUpBound);
    window.removeEventListener("pointercancel", this._onPointerCancelBound);
    window.removeEventListener("pointerleave", this._onPointerCancelBound);
    window.removeEventListener("blur", this._onWindowBlurBound);

    if (this._pointerDownWatchdogId) {
      clearTimeout(this._pointerDownWatchdogId);
      this._pointerDownWatchdogId = undefined;
    }

    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.onUmmount?.();

    // cancel throttled writes
    this._writeFullSceneThrottled.cancel &&
      this._writeFullSceneThrottled.cancel();
  }

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroyCollab({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      (this.fileManager.shouldPreventUnload(syncableElements) ||
        !isSavedToFirebase(this.portal, syncableElements))
    ) {
      // this won't run in time if user decides to leave the site, but
      // the purpose is to run immediately after user decides to stay
      this.saveCollabRoomToFirebase(syncableElements);

      if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
        preventUnload(event);
      } else {
        console.warn(
          "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
        );
      }
    }
  });

  saveCollabRoomToFirebase = async (
    syncableElements: readonly SyncableExcalidrawElement[],
  ) => {
    try {
      const storedElements = await saveToFirebase(
        this.portal,
        syncableElements,
        this.excalidrawAPI.getAppState(),
      );

      this.resetErrorIndicator();

      if (this.isCollaborating() && storedElements) {
        const restored = restoreElements(storedElements, null);
        this.excalidrawAPI.updateScene({
          elements: restored,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    } catch (error: any) {
      const errorMessage = /is longer than.*?bytes/.test(error.message)
        ? t("errors.collabSaveFailed_sizeExceeded")
        : t("errors.collabSaveFailed");

      if (
        !this.state.dialogNotifiedErrors[errorMessage] ||
        !this.isCollaborating()
      ) {
        this.setErrorDialog(errorMessage);
        this.setState({
          dialogNotifiedErrors: {
            ...this.state.dialogNotifiedErrors,
            [errorMessage]: true,
          },
        });
      }

      if (this.isCollaborating()) {
        this.setErrorIndicator(errorMessage);
      }

      console.error(error);
    }
  };

  stopCollaboration = (keepRemoteState = true) => {
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    this.saveCollabRoomToFirebase(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroyCollab();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroyCollab();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };

  private destroyCollab = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();

    if (!opts?.isUnload && this.yjsProvider) {
      try {
        this.yjsProvider.destroy();
      } catch {
        // ignore
      } finally {
        this.yjsProvider = null;
      }
    }

    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.setActiveRoomLink(null);
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      LocalData.resumeSave("collaboration");
    }
  };

  private fetchImageFilesFromFirebase = async (opts: {
    elements: readonly ExcalidrawElement[];
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileTracked(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
              Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private fallbackInitializationHandler: null | (() => any) = null;

  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
  ) => {
    if (!this.state.username) {
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        const username = getRandomUsername();
        this.setUsername(username);
      });
    }

    // If portal.socket is used in your app elsewhere, we deliberately keep it null
    // and rely entirely on Yjs for realtime scene sync.
    if (this.portal.socket) {
      return null;
    }

    let roomId: string;
    let roomKey: string;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
    }

    const scenePromise = resolvablePromise<InitialScene>();

    // store the scenePromise so Yjs flow can resolve it when the first snapshot arrives
    this._initialScenePromise = scenePromise;
    this._initialScenePromiseResolved = false;

    this.setIsCollaborating(true);
    LocalData.pauseSave("collaboration");

    const fallbackInitializationHandler = () => {
      this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
      }).then((scene) => {
        scenePromise.resolve(scene);
      });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    // Resolve Yjs WebSocket endpoint once, for all instances.
    const envYjs = (import.meta.env as any)?.VITE_APP_YJS_WSS;
    const envWsServer = (import.meta.env as any)?.VITE_APP_WS_SERVER_URL;

    const normalizedEnvYjs =
      typeof envYjs === "string" && envYjs.trim().length > 0
        ? envYjs.trim()
        : null;
    const normalizedEnvWsServer =
      typeof envWsServer === "string" && envWsServer.trim().length > 0
        ? envWsServer.trim()
        : null;

    const wsServerUrl =
      normalizedEnvYjs || normalizedEnvWsServer || "ws://localhost:1234";
    console.info(
      "[collab] resolved wsServerUrl:",
      wsServerUrl,
      "room:",
      roomId,
    );

    // Set portal room data for Firebase, but we won't use portal sockets.
    this.portal.roomId = roomId;
    this.portal.roomKey = roomKey;
    this.portal.socket = null;

    try {
      const wsUrlForYjs = wsServerUrl;
      console.info("[collab] Yjs websocket URL:", wsUrlForYjs, "room:", roomId);

      this.yjsProvider = new YjsProvider();
      await this.yjsProvider.init(roomId, wsUrlForYjs, {
        persist: true,
        roomKey,
      });

      // Mark "socket" initialized so Firebase saving logic is enabled.
      this.portal.socketInitialized = true;

      // === Yjs → Excalidraw scene updates ===
      this.yjsProvider.onElementsChanged((elements: any[]) => {
        this._onYjsElementsChanged(elements);
      });

      // === Yjs awareness → collaborators map ===
      this.yjsProvider.onAwareness((states: Map<number, any>) => {
        this._onYjsAwarenessChanged(states);
      });
    } catch (e) {
      console.warn(
        "YjsProvider init failed, falling back to Firebase-based init",
        e,
      );
      this.yjsProvider = null;
      try {
        fallbackInitializationHandler();
      } catch (err) {
        console.error("fallback initialization handler failed", err);
      }
    }

    // Fallback timer if Yjs doesn't deliver a scene in time.
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    this.setActiveRoomLink(window.location.href);

    return scenePromise;
  };

  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
      }
    | { fetchScene: false; roomLinkData?: null }) => {
    clearTimeout(this.socketInitializationTimer!);

    if (fetchScene && roomLinkData && this.portal.socket) {
      this.excalidrawAPI.resetScene();

      try {
        const elements = await loadFromFirebase(
          roomLinkData.roomId,
          roomLinkData.roomKey,
          this.portal.socket,
        );
        if (elements) {
          this.setLastBroadcastedOrReceivedSceneVersion(
            getSceneVersion(elements),
          );

          return {
            elements,
            scrollToContent: true,
          };
        }
      } catch (error: any) {
        console.error(error);
      } finally {
        this.portal.socketInitialized = true;
      }
    } else {
      // Yjs-only mode: mark as initialized for Firebase save logic
      this.portal.socketInitialized = true;
    }
    return null;
  };

  // ===== Yjs → Excalidraw helpers =====

  private _onYjsElementsChanged = (elements: any[]) => {
    try {
      // eslint-disable-next-line no-console
      console.debug("[collab] onElementsChanged received", {
        len: elements?.length ?? 0,
        localPointerDown: this._localPointerDown,
        ts: Date.now(),
      });

      // Ignore empty snapshots (defensive)
      if (!elements || elements.length === 0) {
        console.warn("[collab] Ignoring empty Yjs update");
        return;
      }

      // If user is actively drawing or editing text, queue remote snapshot
      if (this._localPointerDown || this.isTextEditing()) {
        this._pendingRemoteElements = elements;
        // eslint-disable-next-line no-console
        console.debug(
          "[collab] queued remote elements while local interaction active:",
          elements?.length ?? 0,
        );
        return;
      }

      this._applyYjsElements(elements);
    } catch (e) {
      console.error("[collab] onElementsChanged handler error", e);
    }
  };

  private _applyYjsElements = (elements: readonly any[]) => {
    if (!elements || elements.length === 0) {
      return;
    }

    if (this._applyingRemote) {
      this._pendingRemoteElements = elements;
      return;
    }

    if (this._localPointerDown || this.isTextEditing()) {
      this._pendingRemoteElements = elements;
      return;
    }

    this._applyingRemote = true;
    try {
      // restore remote elements to Excalidraw shape
      const restoredRemote = restoreElements(
        elements as any,
        null,
      ) as ExcalidrawElement[];

      // merge remote into local scene (preserve local edits, especially text editing)
      const merged = this.mergeRemoteIntoLocal(restoredRemote);

      // ensure fresh identities (shallow clones) for safe re-rendering
      const withFreshIds = merged.map((el: any) => ({ ...el }));

      // Resolve initial scene promise exactly once
      if (this._initialScenePromise && !this._initialScenePromiseResolved) {
        this._initialScenePromiseResolved = true;
        this._initialScenePromise.resolve({
          elements: withFreshIds,
          scrollToContent: true,
        });

        if (this.socketInitializationTimer) {
          clearTimeout(this.socketInitializationTimer);
          this.socketInitializationTimer = undefined;
        }
      }

      this.excalidrawAPI.updateScene({
        elements: withFreshIds,
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      this.loadImageFiles();
    } catch (err) {
      console.error("[collab] failed to apply Yjs elements", err);
    } finally {
      this._applyingRemote = false;

      // If new remote elements arrived while we were applying, and we're not drawing,
      // immediately apply the latest snapshot.
      if (!this._localPointerDown && this._pendingRemoteElements) {
        const pending = this._pendingRemoteElements;
        this._pendingRemoteElements = null;
        this._applyYjsElements(pending);
      }
    }
  };

  private _onYjsAwarenessChanged = (states: Map<number, any>) => {
    try {
      const collaboratorsMap = new Map<SocketId, Collaborator>();

      const status = this.yjsProvider?.getStatus();
      const provider = (status?.provider as any) || null;
      let localClientId: number | null = null;

      try {
        localClientId =
          (provider && provider.awareness && provider.awareness.clientID) ??
          (this.yjsProvider as any).doc?.clientID ??
          null;
      } catch {
        localClientId = null;
      }

      for (const [clientId, state] of Array.from(states.entries())) {
        collaboratorsMap.set(
          String(clientId) as unknown as SocketId,
          {
            ...state,
            isCurrentUser:
              localClientId !== null ? clientId === localClientId : false,
          } as Collaborator,
        );
      }

      this.collaborators = collaboratorsMap;
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
    } catch (e) {
      console.warn("Error mapping Yjs awareness to collaborators", e);
    }
  };

  // ===== Scene utilities =====

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  private loadImageFiles = throttle(async () => {
    const { loadedFiles, erroredFiles } =
      await this.fetchImageFilesFromFirebase({
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      });

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(sockets: SocketId[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      collaborators.set(
        socketId,
        Object.assign({}, this.collaborators.get(socketId), {
          isCurrentUser: false,
        }),
      );
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });
  }

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      {},
      collaborators.get(socketId),
      updates,
      {
        isCurrentUser: false,
      },
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  // ===== Cursors / presence (via Yjs awareness) =====

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      try {
        const status = this.yjsProvider?.getStatus();
        const provider = status?.provider as any;
        if (
          provider &&
          provider.awareness &&
          typeof provider.awareness.setLocalState === "function" &&
          payload.pointersMap.size < 2
        ) {
          const prev = provider.awareness.getLocalState() || {};
          provider.awareness.setLocalState({
            ...prev,
            pointer: payload.pointer,
            button: payload.button,
            username: this.state.username,
            selectedElementIds:
              payload.pointersMap && payload.pointersMap.size > 0
                ? Array.from(payload.pointersMap.keys())
                : [],
          });
        }
      } catch (e) {
        console.warn("[collab] onPointerUpdate awareness error", e);
      }
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    // Optional: you can encode viewport bounds into awareness as well.
    const appState = this.excalidrawAPI.getAppState();
    const bounds = getVisibleSceneBounds(appState);

    try {
      const status = this.yjsProvider?.getStatus();
      const provider = status?.provider as any;
      if (!provider?.awareness?.setLocalState) {
        return;
      }

      const prev = provider.awareness.getLocalState() || {};
      if (props?.force || appState.followedBy.size > 0) {
        provider.awareness.setLocalState({
          ...prev,
          viewportBounds: bounds,
        });
      }
    } catch (e) {
      console.warn("[collab] relayVisibleSceneBounds awareness error", e);
    }
  };

  onIdleStateChange = (userState: UserIdleState) => {
    try {
      const status = this.yjsProvider?.getStatus();
      const provider = status?.provider as any;
      if (!provider?.awareness?.setLocalState) {
        return;
      }
      const prev = provider.awareness.getLocalState() || {};
      provider.awareness.setLocalState({
        ...prev,
        idleState: userState,
        username: this.state.username,
      });
    } catch (e) {
      console.warn("[collab] onIdleStateChange awareness error", e);
    }
  };

  // ===== Excalidraw → Yjs sync =====

  private _writeFullSceneToYjsSafe = () => {
    if (!this.yjsProvider) {
      return;
    }

    // Never write while drawing or while editing text (avoid wiping local editing state)
    if (this._localPointerDown || this.isTextEditing()) {
      return;
    }

    try {
      const fullScene = this.excalidrawAPI.getSceneElementsIncludingDeleted();

      // IMPORTANT: your YjsProvider.writeElements is synchronous (mutates Y.Doc inside transact).
      // Call it synchronously to avoid awaiting a non-promise and making things worse.
      try {
        (this.yjsProvider as any).writeElements(fullScene as any);
        // eslint-disable-next-line no-console
        console.debug("[collab] full scene written to Yjs", {
          count: fullScene.length,
          ts: Date.now(),
        });
      } catch (innerErr) {
        console.error(
          "[collab] error calling yjsProvider.writeElements",
          innerErr,
        );
      }
    } catch (e) {
      console.error("[collab] writeElements to Yjs failed", e);
    }
  };

  /**
   * Excalidraw calls this on every element change.
   * We:
   * - ignore calls with no elements
   * - never write while the pointer is down (stroke still evolving)
   * - write the full scene when safe
   */
  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    if (!elements || elements.length === 0) {
      return;
    }

    // If no Yjs provider, nothing to do (pure local mode).
    if (!this.yjsProvider) {
      return;
    }

    // Don’t sync mid-stroke — we’ll sync on pointerUp instead.
    // Determine if the user is *drawing a stroke* right now
    const isDrawingStroke =
      this._localPointerDown &&
      elements.some(
        (el) =>
          el.type === "freedraw" || el.type === "line" || el.type === "arrow",
      );

    // Only skip mid-stroke for stroke types
    if (isDrawingStroke) {
      // Don't commit incomplete strokes
      return;
    }

    // For shapes + text + arrows after pointerUp → always commit
    const containsText = elements.some((el) => el.type === "text");

    // Use throttled writer for both text and non-text, so writes are rate-limited.
    // For text we call flush to ensure someone typing will be sent reasonably quickly.
    if (containsText) {
      // flushing throttled function will schedule/emit appropriately
      this._writeFullSceneThrottled();
    } else {
      this._writeFullSceneThrottled();
    }

    // keep Firebase persistence as before
    try {
      this.queueSaveToFirebase();
    } catch {
      // ignore
    }
  };

  // ===== Batching for sync =====

  private _queueForSync: OrderedExcalidrawElement[] | null = null;

  queueSceneForSync(elements: readonly OrderedExcalidrawElement[]) {
    this._queueForSync = elements as OrderedExcalidrawElement[];
  }

  flushQueuedSync() {
    if (!this._queueForSync) {
      return;
    }
    this.syncElements(this._queueForSync);
    this._queueForSync = null;
  }

  queueSaveToFirebase = throttle(
    () => {
      if (this.portal.socketInitialized) {
        this.saveCollabRoomToFirebase(
          getSyncableElements(
            this.excalidrawAPI.getSceneElementsIncludingDeleted(),
          ),
        );
      }
    },
    SYNC_FULL_SCENE_INTERVAL_MS,
    { leading: false },
  );

  // ===== Merge utility (remote -> local) =====

  /**
   * Merge remote snapshot into local scene:
   * - keep local element if user is currently editing that element
   * - otherwise pick element with higher `updated` timestamp (remote wins if newer)
   * - preserve remote ordering; append local-only items at the end
   */
  private mergeRemoteIntoLocal(
    remote: ExcalidrawElement[],
  ): ExcalidrawElement[] {
    const local = this.excalidrawAPI.getSceneElementsIncludingDeleted();
    const localById = new Map<string, ExcalidrawElement>();
    for (const le of local) {
      localById.set(le.id, le);
    }

    const editingElement = this.excalidrawAPI.getAppState().editingTextElement;
    const editingId = editingElement ? editingElement.id : null;

    const merged: ExcalidrawElement[] = [];

    // Build set of remote ids to preserve order
    const remoteIds = new Set<string>();
    for (const re of remote) {
      remoteIds.add(re.id);
      const localEl = localById.get(re.id);
      if (localEl) {
        // If user is editing this element locally, keep local version
        if (editingId && editingId === re.id) {
          merged.push(localEl);
        } else {
          // Use updated timestamp if present, otherwise fallback to remote
          const localUpdated = (localEl as any).updated ?? 0;
          const remoteUpdated = (re as any).updated ?? 0;
          if (remoteUpdated >= localUpdated) {
            merged.push(re);
          } else {
            merged.push(localEl);
          }
        }
        // remove from localById processed
        localById.delete(re.id);
      } else {
        // remote-only element: add it
        merged.push(re);
      }
    }

    // Append any remaining local-only elements that didn't exist in remote
    for (const [, leftoverLocal] of localById.entries()) {
      // keep the local element as-is
      merged.push(leftoverLocal);
    }

    return merged;
  }

  // ===== Username / room link / errors =====

  setUsername = (username: string) => {
    this.setState({ username });
    saveUsernameToLocalStorage(username);
  };

  getUsername = () => this.state.username;

  setActiveRoomLink = (activeRoomLink: string | null) => {
    this.setState({ activeRoomLink });
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  getActiveRoomLink = () => this.state.activeRoomLink;

  setErrorIndicator = (errorMessage: string | null) => {
    appJotaiStore.set(collabErrorIndicatorAtom, {
      message: errorMessage,
      nonce: Date.now(),
    });
  };

  resetErrorIndicator = (resetDialogNotifiedErrors = false) => {
    appJotaiStore.set(collabErrorIndicatorAtom, { message: null, nonce: 0 });
    if (resetDialogNotifiedErrors) {
      this.setState({
        dialogNotifiedErrors: {},
      });
    }
  };

  setErrorDialog = (errorMessage: string | null) => {
    this.setState({
      errorMessage,
    });
  };

  render() {
    const { errorMessage } = this.state;

    return (
      <>
        {errorMessage != null && (
          <ErrorDialog onClose={() => this.setErrorDialog(null)}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }

  // ===== helpers =====

  private isTextEditing(): boolean {
    try {
      const appState = this.excalidrawAPI.getAppState();
      return !!appState?.editingTextElement; // true if user is currently editing text
    } catch {
      return false;
    }
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof Collab>;
  }
}

if (isTestEnv() || isDevEnv()) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default Collab;
export type TCollabClass = Collab;
