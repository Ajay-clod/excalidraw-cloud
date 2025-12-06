/**
 * excalidraw-app/collab/Collab.tsx (Yjs-only variant) — combined final (fixed types)
 *
 * This file includes:
 * - Yjs-only collaboration wiring
 * - Robust pointerdown/pointerup bound handlers
 * - Initial scene promise resolution when first Yjs snapshot arrives
 * - Queueing of remote snapshots while local pointer is down
 * - Debounced writer with reliable flush handlers
 * - Integration with YjsProvider.writePoints for incremental stroke updates
 * - Final commit on pointerup to write full elements
 *
 * Note: This file expects YjsProvider (excalidraw-app/collab/YjsProvider.ts) to expose:
 * - init(roomId, wsUrl, opts)
 * - writeElements(elements)
 * - writePoints(elementId, pointsBatch)
 * - onElementsChanged(cb)
 * - onAwareness(cb)
 * - getStatus()
 * - destroy()
 *
 * Keep logging minimal in production.
 */

import {
  CaptureUpdateAction,
  getSceneVersion,
  restoreElements,
  zoomToFitBounds,
  reconcileElements,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { APP_NAME, EVENT } from "@excalidraw/common";
import {
  IDLE_THRESHOLD,
  ACTIVE_THRESHOLD,
  UserIdleState,
  assertNever,
  isDevEnv,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  throttleRAF,
} from "@excalidraw/common";
import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { getVisibleSceneBounds } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element";
import { isImageElement, isInitializedImageElement } from "@excalidraw/element";
import { AbortError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";
import { withBatchedUpdates } from "@excalidraw/excalidraw/reactUtils";

import throttle from "lodash.throttle";
import { PureComponent } from "react";

import type {
  ReconciledExcalidrawElement,
  RemoteExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";
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
import type { Mutable, ValueOf } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SUBTYPES,
  SYNC_FULL_SCENE_INTERVAL_MS,
  WS_EVENTS,
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

import type {
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";

/* === YjsProvider import ===
   This is the local provider wrapper file (YjsProvider.ts).
*/
import YjsProvider from "./YjsProvider";

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

  // Minimal flags/state for safe apply
  private _applyingRemote: boolean = false;
  private _pendingRemoteElements: ReadonlyArray<any> | null = null;
  private _localPointerDown: boolean = false;
  private _yjsHandlersAttached: boolean = false;

  // Debounce writer state (kept readonly to match incoming signatures)
  private _debouncedWrite?: ((elements: readonly any[]) => void) & { flush?: () => void };
  private _debounceTimer: any = null;
  private _debounceLastArgs: readonly any[] | null = null;

  // Bound handlers so we can reliably add/remove listeners
  private _onPointerDownBound = () => {
    this._localPointerDown = true;
  };
  private _onPointerUpBound = () => {
    this._localPointerDown = false;
    // if any pending snapshot queued while drawing, apply it now
    try {
      if (this._pendingRemoteElements && this.excalidrawAPI) {
        const queued = this._pendingRemoteElements;
        this._pendingRemoteElements = null;
        const restored = restoreElements(queued as any, null);
        this.excalidrawAPI.updateScene({
          elements: restored,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        this.loadImageFiles();
      }
    } catch (e) {
      /* non-fatal */
    }

    // commit any in-progress local strokes to Yjs as final elements
    try {
      this._commitInProgressElements();
    } catch (e) {
      console.warn("[collab] commitInProgressElements failed", e);
    }

    // flush any debounced writes (if present)
    try {
      this._debouncedWrite && this._debouncedWrite.flush && this._debouncedWrite.flush();
    } catch (_) {}
  };
  private _flushDebouncedWriteBound = () => {
    try {
      this._debouncedWrite && this._debouncedWrite.flush && this._debouncedWrite.flush();
    } catch (_) {}
  };
  private _onVisibilityHiddenFlushBound = () => {
    if (document.visibilityState === "hidden") {
      this._flushDebouncedWriteBound();
    }
  };

  // initial scene promise state (so Yjs flow resolves startCollaboration)
  private _initialScenePromise?: {
    resolve: (value: InitialScene | Promise<InitialScene>) => void;
    reject: (error: Error) => void;
  };
  private _initialScenePromiseResolved: boolean = false;

  // NEW: incremental point sync tracking
  private _lastPointsCount: Map<string, number> = new Map();
  private _inProgressElementIds: Set<string> = new Set();

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
  }

  private onUmmount: (() => void) | null = null;

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    // track pointer state so we don't apply incoming snapshots mid-stroke
    window.addEventListener("pointerdown", this._onPointerDownBound, { passive: true });
    window.addEventListener("pointerup", this._onPointerUpBound, { passive: true });

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      this.portal.socket && this.portal.broadcastUserFollowed(payload);
    });
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

    // remove bound pointer handlers reliably
    window.removeEventListener("pointerdown", this._onPointerDownBound);
    window.removeEventListener("pointerup", this._onPointerUpBound);

    // remove flush handlers registered by ensureDebouncedWrite
    window.removeEventListener("pointerup", this._flushDebouncedWriteBound);
    document.removeEventListener("visibilitychange", this._onVisibilityHiddenFlushBound);

    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.onUmmount?.();
  }

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
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
      //  the purpose is to run in immediately after user decides to stay
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
        this.handleRemoteSceneUpdate(this._reconcileElements(storedElements));
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
    this.queueBroadcastAllElements.cancel();
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
      this.destroySocketClient();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI.getSceneElementsIncludingDeleted().map((element) => {
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

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();

    /* Cleanup Yjs provider if present */
    if (!opts?.isUnload && this.yjsProvider) {
      try {
        this.yjsProvider.destroy();
      } catch (e) {
        // ignore
      } finally {
        this._yjsHandlersAttached = false;
        this._pendingRemoteElements = null;
        this._applyingRemote = false;
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

  private decryptPayload = async (
    iv: Uint8Array,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: WS_SUBTYPES.INVALID_RESPONSE,
      };
    }
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

    if (this.portal.socket) {
      // If some socket is already opened, don't start again.
      return null;
    }

    let roomId;
    let roomKey;

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

    // --- safe ws url computation (single normalized value) ---
    const envYjs = (import.meta.env as any)?.VITE_APP_YJS_WSS;
    const envWsServer = (import.meta.env as any)?.VITE_APP_WS_SERVER_URL;

    const normalizedEnvYjs =
      typeof envYjs === "string" && envYjs.trim().length > 0 ? envYjs.trim() : null;
    const normalizedEnvWsServer =
      typeof envWsServer === "string" && envWsServer.trim().length > 0 ? envWsServer.trim() : null;

    const wsServerUrl = normalizedEnvYjs || normalizedEnvWsServer || "ws://localhost:1234";
    console.info("[collab] resolved wsServerUrl:", wsServerUrl, "room:", roomId);

    // Yjs-only path: don't instantiate shim. Set portal.roomId/roomKey so FileManager works.
    this.portal.roomId = roomId;
    this.portal.roomKey = roomKey;
    // Keep portal.socket null (no shim)
    this.portal.socket = null;

    try {
      const wsUrlForYjs = wsServerUrl;
      console.info("[collab] Yjs websocket URL:", wsUrlForYjs, "room:", roomId);

      this.yjsProvider = new YjsProvider();

      // try to init; if it fails, fallback to firebase-based initialization
      await this.yjsProvider.init(roomId, wsUrlForYjs, { persist: true, roomKey });

      // provider initialized; mark portal as initialized so other code relying on socketInitialized proceeds
      this.portal.socketInitialized = true;

      // ensure instance-scoped guard/queue exist so they persist and are unique per Collab instance
      (this as any)._applyingRemote = (this as any)._applyingRemote || false;
      (this as any)._pendingRemoteElements = (this as any)._pendingRemoteElements || null;

      const applyRemoteElementsSafely = (elements: readonly any[]) => {
        // If excalidraw API not ready yet, keep last remote snapshot for later
        if (!this.excalidrawAPI || typeof this._reconcileElements !== "function") {
          (this as any)._pendingRemoteElements = elements;
          console.info("[collab] excalidrawAPI not ready — queued remote elements:", elements?.length ?? 0);
          return;
        }

        // Prevent re-entrancy
        if ((this as any)._applyingRemote) {
          (this as any)._pendingRemoteElements = elements;
          console.debug("[collab] skipping re-entrant onElementsChanged; queued latest remote elements:", elements?.length ?? 0);
          return;
        }

        (this as any)._applyingRemote = true;

        // Defer actual reconcile+apply to next animation frame to avoid nested React updates
        window.requestAnimationFrame(() => {
          try {
            const reconciled = this._reconcileElements(elements);
            // resolve startCollaboration scenePromise if present (only once)
            try {
              if (this._initialScenePromise && !this._initialScenePromiseResolved) {
                this._initialScenePromiseResolved = true;
                this._initialScenePromise.resolve({
                  elements: reconciled,
                  scrollToContent: true,
                });
                // clear the initialization fallback timer if present
                if (this.socketInitializationTimer) {
                  clearTimeout(this.socketInitializationTimer);
                  this.socketInitializationTimer = undefined;
                }
              }
            } catch (e) {
              console.warn("[collab] resolving initial scene promise failed", e);
            }
            // handleRemoteSceneUpdate should call excalidrawAPI.updateScene with CaptureUpdateAction.NEVER
            this.handleRemoteSceneUpdate(reconciled);
            console.info("[collab] applied remote elements:", reconciled.length);
          } catch (err) {
            console.error("[collab] Failed to handle Yjs elements", err);
          } finally {
            setTimeout(() => {
              (this as any)._applyingRemote = false;
              const pending = (this as any)._pendingRemoteElements;
              (this as any)._pendingRemoteElements = null;
              if (pending) {
                applyRemoteElementsSafely(pending as readonly any[]);
              }
            }, 0);
          }
        });
      };

      // Register exactly one handler
      this.yjsProvider.onElementsChanged((elements: any[]) => {
        try {
          // If pointer is down, queue snapshot (we already track local pointer via handlers)
          if (this._localPointerDown) {
            this._pendingRemoteElements = elements;
            console.debug("[collab] queued remote elements while pointer is down:", elements?.length ?? 0);
            return;
          }
          applyRemoteElementsSafely(elements);
        } catch (e) {
          console.error("[collab] onElementsChanged handler error", e);
        }
      });

      // If pending elements exist and excalidrawAPI is ready now, apply them immediately
      if ((this as any)._pendingRemoteElements && this.excalidrawAPI) {
        const queued = (this as any)._pendingRemoteElements;
        (this as any)._pendingRemoteElements = null;
        applyRemoteElementsSafely(queued as readonly any[]);
      }

      // Awareness -> convert to collaborators map for UI, mark local client where possible
      this.yjsProvider.onAwareness((states: Map<number, any>) => {
        try {
          const collaboratorsMap = new Map<SocketId, Collaborator>();

          // try to detect local client id from provider (best-effort)
          const provider = (this.yjsProvider?.getStatus?.().provider) || null;
          let localClientId: number | null = null;
          try {
            localClientId = (provider && provider.awareness && provider.awareness.clientID) ?? (this.yjsProvider as any).doc?.clientID ?? null;
          } catch (_) {
            localClientId = null;
          }

          for (const [clientId, state] of Array.from(states.entries())) {
            collaboratorsMap.set(String(clientId) as unknown as SocketId, {
              ...state,
              isCurrentUser: localClientId !== null ? clientId === localClientId : false,
            } as Collaborator);
          }
          this.collaborators = collaboratorsMap;
          this.excalidrawAPI.updateScene({ collaborators: this.collaborators });
        } catch (e) {
          console.warn("Error mapping Yjs awareness to collaborators", e);
        }
      });


      // If you want to emit first-in-room or similar, you can derive it from awareness states here.

      // If yjsProvider is available we may want to resolve initial scene from it:
      // Wait a beat for IndexedDB sync to complete if persistence is enabled; otherwise rely on onElementsChanged to arrive.
      // To be conservative, do not resolve scenePromise here immediately; the onElementsChanged will call handleRemoteSceneUpdate instead.
    } catch (e) {
      console.warn("YjsProvider init failed, falling back to Firebase-based init", e);
      this.yjsProvider = null;
      // run fallback to initialize from firebase
      try {
        fallbackInitializationHandler();
      } catch (err) {
        console.error("fallback initialization handler failed", err);
      }
    }

    // If the rest of the app expects socket events (client-broadcast etc), we are no-op there
    // because we don't instantiate shim — any code relying on shim-emitted client-broadcast will not run.

    // Start a timer that falls back to firebase init if nothing happened
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // NOTE: we removed shim-based socket listeners; portal.socket remains null.
    // The prior client-broadcast listener used to be set up here — it's removed in Yjs-only flow.

    // Set active room link and return scenePromise; onElementsChanged will drive updates
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

    // No shim socket to remove connect_error handler from; if portal.socket existed we'd do so
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
      // If using Yjs-only, mark socketInitialized so other flows proceed
      this.portal.socketInitialized = true;
    }
    return null;
  };

  private _reconcileElements = (
    remoteElements: readonly ExcalidrawElement[],
  ): ReconciledExcalidrawElement[] => {
    const localElements = this.getSceneElementsIncludingDeleted();
    const appState = this.excalidrawAPI.getAppState();
    const restoredRemoteElements = restoreElements(remoteElements, null);
    const reconciledElements = reconcileElements(
      localElements,
      restoredRemoteElements as RemoteExcalidrawElement[],
      appState,
    );

    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
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

  private handleRemoteSceneUpdate = (
    elements: ReconciledExcalidrawElement[],
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.loadImageFiles();
  };

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
          isCurrentUser: socketId === this.portal.socket?.id,
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
        isCurrentUser: socketId === this.portal.socket?.id,
      },
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  /* onPointerUpdate now prefers Yjs awareness */
  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      try {
        if (
          this.yjsProvider &&
          this.yjsProvider.getStatus().provider &&
          payload.pointersMap.size < 2
        ) {
          const provider = (this.yjsProvider.getStatus().provider as any);
          if (provider && provider.awareness && provider.awareness.setLocalState) {
            provider.awareness.setLocalState({
              pointer: payload.pointer,
              button: payload.button,
              username: this.state.username,
              selectedElementIds:
                payload.pointersMap && payload.pointersMap.size > 0
                  ? Array.from(payload.pointersMap.keys())
                  : [],
            });
            return;
          }
        }
      } catch (e) {
        // swallow and fallthrough to legacy if necessary
      }

      // legacy fallback only if Yjs not available
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    const appState = this.excalidrawAPI.getAppState();

    if (this.portal.socket && (appState.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds(
        {
          sceneBounds: getVisibleSceneBounds(appState),
        },
        `follow@${this.portal.socket.id}`,
      );
    }
  };

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly OrderedExcalidrawElement[]) => {
    // In Yjs mode prefer writing the canonical full scene (avoid partial races)
    if (this.yjsProvider && typeof (this.yjsProvider as any).writeElements === "function") {
      try {
        const full = this.excalidrawAPI.getSceneElementsIncludingDeleted();
        (this.yjsProvider as any).writeElements(full as any);
        return;
      } catch (e) {
        console.error("Yjs writeElements failed, falling back to portal.broadcastScene", e);
      }
    }

    // fallback: use portal transport if available
    if (this.portal) {
      this.portal.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  /* Debounced writer and helpers */
  ensureDebouncedWrite(wait = 80) {
    if (this._debouncedWrite) return;

    const flush = () => {
      if (!this._debounceLastArgs) return;
      try {
        if (this.yjsProvider && typeof (this.yjsProvider as any).writeElements === "function") {
          const full = this.excalidrawAPI.getSceneElementsIncludingDeleted();
          (this.yjsProvider as any).writeElements(full as any);
        }
      } catch (e) {
        console.error("[collab] debounced write failed", e);
      }
      this._debounceLastArgs = null;
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    };

    const debounced = (elements: readonly any[]) => {
      this._debounceLastArgs = elements;
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
      }
      this._debounceTimer = setTimeout(flush, wait);
    };

    debounced.flush = flush;
    this._debouncedWrite = debounced;

    // Use stored bound flush handler so we can remove it later
    window.addEventListener("pointerup", this._flushDebouncedWriteBound, { passive: true });
    document.addEventListener("visibilitychange", this._onVisibilityHiddenFlushBound);
    window.addEventListener("pagehide", this._flushDebouncedWriteBound, { passive: true });
  }

  /* Commit final state for elements that were being streamed via writePoints */
  private _commitInProgressElements = () => {
    if (!this.yjsProvider) {
      this._inProgressElementIds.clear();
      this._lastPointsCount.clear();
      return;
    }
    try {
      const providerHasWriteElements = typeof (this.yjsProvider as any).writeElements === "function";
      if (!providerHasWriteElements) {
        // nothing to commit; just clear memory
        this._inProgressElementIds.clear();
        this._lastPointsCount.clear();
        return;
      }

      const sceneElements = this.excalidrawAPI.getSceneElementsIncludingDeleted();
      const toCommit = sceneElements.filter((el) =>
        this._inProgressElementIds.has((el as any).id),
      );

      if (toCommit.length > 0) {
        try {
          (this.yjsProvider as any).writeElements(toCommit as any);
        } catch (e) {
          console.error("[collab] failed to commit in-progress elements via writeElements", e);
        }
      }
    } finally {
      // clear tracking after attempt to commit
      for (const id of Array.from(this._inProgressElementIds)) {
        this._lastPointsCount.delete(id);
      }
      this._inProgressElementIds.clear();
    }
  };

  /* syncElements prefers Yjs writes when available */
  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    const hasDeletion = (elements as any[]).some((el) => (el as any).isDeleted === true);

    if (this.yjsProvider && typeof (this.yjsProvider as any).writeElements === "function") {
      this.ensureDebouncedWrite();

      // If provider supports writePoints, try to push deltas for strokes
      const providerHasWritePoints = typeof (this.yjsProvider as any).writePoints === "function";

      let filteredElements = Array.from(elements) as OrderedExcalidrawElement[];

      if (providerHasWritePoints) {
        try {
          const strokeTypes = new Set(["freedraw", "linear"]); // adjust to your element types as needed
          for (const el of elements as any[]) {
            if (!el || !el.id) continue;
            const type = (el as any).type;
            if (strokeTypes.has(type) && Array.isArray((el as any).points)) {
              const id = el.id;
              const prevLen = this._lastPointsCount.get(id) || 0;
              const currLen = (el as any).points.length || 0;
              if (currLen > prevLen) {
                const newPoints = (el as any).points.slice(prevLen, currLen);
                if (newPoints.length > 0) {
                  try {
                    (this.yjsProvider as any).writePoints(id, newPoints);
                    // mark as in progress
                    this._inProgressElementIds.add(id);
                    this._lastPointsCount.set(id, currLen);
                    // remove this element from filteredElements to avoid re-sending whole element
                    filteredElements = filteredElements.filter((f) => (f as any).id !== id);
                  } catch (e) {
                    console.error("[collab] writePoints failed, will fallback to writeElements", e);
                    this._inProgressElementIds.delete(id);
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn("[collab] incremental writePoints handling errored", e);
        }
      }

      // If there is a deletion among the supplied elements, prefer immediate full write for safety
      if (hasDeletion) {
        try {
          const full = this.excalidrawAPI.getSceneElementsIncludingDeleted();
          (this.yjsProvider as any).writeElements(full as any);
        } catch (e) {
          console.error("[collab] immediate Yjs write failed, falling back to broadcast", e);
          this.broadcastElements(elements as any);
        }
      } else {
        try {
          if (filteredElements.length > 0) {
            // Use debounced writer for remaining elements
            this._debouncedWrite && this._debouncedWrite(filteredElements as any);
          } else {
            // No remaining elements to write; nothing else to do
          }
        } catch (e) {
          console.error("[collab] debounced write failed, fallback to direct", e);
          try {
            const full = this.excalidrawAPI.getSceneElementsIncludingDeleted();
            (this.yjsProvider as any).writeElements(full as any);
          } catch (err) {
            this.broadcastElements(elements as any);
          }
        }
      }
    } else {
      this.broadcastElements(elements);
    }

    try {
      this.queueSaveToFirebase();
    } catch (_) {}
  };

  queueBroadcastAllElements = throttle(() => {
    // If using Yjs, avoid redundant periodic full-scene writes (Yjs persistence handles it)
    if (this.yjsProvider) {
      return;
    }

    // fallback to portal-based broadcast
    this.portal.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

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