/* excalidraw-app/collab/YjsProvider.ts
   Yjs provider wrapper with read + write helpers for Excalidraw elements.
   - init(roomId, wsUrl, opts)
   - writeElements(elements)
   - writePoints(elementId, pointsBatch)
   - deleteElement(id)
   - onElementsChanged(cb)
   - onAwareness(cb)
   - getStatus()
   - destroy()
*/
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";

import type { ExcalidrawElement } from "@excalidraw/element/types";

export type YjsProviderOpts = {
  persist?: boolean;
  roomKey?: string | null;
};

export type ElementsChangeCallback = (elements: ExcalidrawElement[]) => void;
export type AwarenessChangeCallback = (states: Map<number, any>) => void;

export default class YjsProvider {
  doc: Y.Doc;
  provider: WebsocketProvider | null = null;
  indexeddb?: IndexeddbPersistence;
  elementsMap: Y.Map<Y.Map<any>>;
  orderArray: Y.Array<string>;
  roomId: string | null = null;

  private onElementsCb?: ElementsChangeCallback;
  private onAwarenessCb?: AwarenessChangeCallback;

  constructor() {
    this.doc = new Y.Doc();
    this.elementsMap = this.doc.getMap("elements");
    this.orderArray = this.doc.getArray("order");

    // Debug: log binary updates produced by this local Y.Doc.
    this.doc.on("update", (update: Uint8Array, origin: any) => {
      try {
        // eslint-disable-next-line no-console
        console.debug("[yjsprovider] doc.update", {
          bytes: update?.byteLength ?? 0,
          origin: origin ?? null,
          roomId: this.roomId,
          ts: Date.now(),
        });
      } catch (e) {
        // swallow logging errors
      }
    });
  }

  async init(roomId: string, wsUrl: string, opts: YjsProviderOpts = {}) {
    this.roomId = roomId;

    if (opts.persist) {
      try {
        this.indexeddb = new IndexeddbPersistence(
          `excalidraw-${roomId}`,
          this.doc,
        );
        await this.indexeddb.whenSynced;
        // eslint-disable-next-line no-console
        console.info("[yjsprovider] indexeddb persistence synced", { roomId });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("IndexeddbPersistence init failed", e);
      }
    }

    this.provider = new WebsocketProvider(wsUrl, roomId, this.doc, {
      connect: true,
    });

    try {
      (this.provider as any).on("status", (event: any) => {
        // eslint-disable-next-line no-console
        console.info("[yjsprovider] websocket status", {
          status: event.status ?? event,
          roomId,
          ts: Date.now(),
        });
      });
    } catch (_) {
      // ignore if provider version doesn't support this hook
    }

    this.elementsMap.observe(this._onYChange);
    this.orderArray.observe(this._onYChange);

    if ((this.provider as any).awareness) {
      (this.provider as any).awareness.on("change", this._onAwarenessChange);
    }

    return this;
  }

  destroy() {
    try {
      this.elementsMap.unobserve(this._onYChange);
      this.orderArray.unobserve(this._onYChange);
    } catch (e) {}
    if (this.provider && (this.provider as any).awareness) {
      (this.provider as any).awareness.off("change", this._onAwarenessChange);
    }
    if (this.provider) {
      try {
        this.provider.destroy();
      } catch (e) {}
      this.provider = null;
    }
    this.roomId = null;
  }

  // 🔹 NEW: helper to recognize stroke-like elements
  private isStrokeElement(el: ExcalidrawElement): boolean {
    const t = (el as any).type;
    return t === "freedraw" || t === "line" || t === "arrow";
  }

  // Convert Y.Map/Y.Array/Y.Text -> ExcalidrawElement
  private yMapToElement(id: string, ymap: Y.Map<any>): ExcalidrawElement {
    const el: any = { id };
    ymap.forEach((v: any, k: string) => {
      // if this value is a Y.Array, convert to a JS array
      if (v instanceof Y.Array) {
        try {
          el[k] = v.toArray();
        } catch (_) {
          el[k] = [];
        }
      } else if (v instanceof Y.Text) {
        try {
          el[k] = v.toString();
        } catch (_) {
          el[k] = "";
        }
      } else {
        el[k] = v;
      }
    });
    return el as ExcalidrawElement;
  }

  // Read all elements in order (if order array present) or map order
  readAllElements(): ExcalidrawElement[] {
    const out: ExcalidrawElement[] = [];
    const order = this.orderArray.toArray();
    if (order.length > 0) {
      for (const id of order) {
        const ym = this.elementsMap.get(id) as Y.Map<any> | undefined;
        if (ym) {
          out.push(this.yMapToElement(id, ym));
        }
      }
    } else {
      this.elementsMap.forEach((ym: Y.Map<any>, id: string) => {
        out.push(this.yMapToElement(id, ym));
      });
    }
    return out;
  }

  // Write many elements in a transaction. Each element becomes a Y.Map stored at elementsMap[id].
  // This will update non-point fields and ensure points are represented as Y.Array (replace)
  writeElements(elements: ExcalidrawElement[]) {
    // Debug: log call
    // eslint-disable-next-line no-console
    console.info("[yjsprovider] writeElements called", {
      count: elements?.length ?? 0,
      roomId: this.roomId,
      ts: Date.now(),
    });

    const origin = "collab-write";
    this.doc.transact(() => {
      for (const element of elements) {
        // 🔒 Skip half-baked stroke elements (only a dot).
        if (
          this.isStrokeElement(element) &&
          (!Array.isArray((element as any).points) ||
            (element as any).points.length < 2)
        ) {
          continue;
        }

        this.setElementYMap(element, { replacePoints: true });
      }
    }, origin);
  }

  // Append incremental points for a given element (efficient small ops).
  writePoints(elementId: string, pointsBatch: any[]) {
    if (!pointsBatch || pointsBatch.length === 0) {
      return;
    }
    // eslint-disable-next-line no-console
    console.debug("[yjsprovider] writePoints", {
      id: elementId,
      batchLen: pointsBatch.length,
      roomId: this.roomId,
      ts: Date.now(),
    });

    this.doc.transact(() => {
      let ym = this.elementsMap.get(elementId) as Y.Map<any> | undefined;
      if (!ym) {
        ym = new Y.Map();
        this.elementsMap.set(elementId, ym);
        // ensure order
        if (!this.orderArray.toArray().includes(elementId)) {
          this.orderArray.push([elementId]);
        }
      }
      let ypoints = ym.get("points") as Y.Array<any> | undefined;
      if (!ypoints) {
        ypoints = new Y.Array();
        ym.set("points", ypoints);
      }
      // push batch
      ypoints.push(pointsBatch);
    }, "points-append");
  }

  // Delete an element (remove from map and order array)
  deleteElement(id: string) {
    this.doc.transact(() => {
      this.elementsMap.delete(id);
      const arr = this.orderArray.toArray();
      const idx = arr.indexOf(id);
      if (idx !== -1) {
        this.orderArray.delete(idx, 1);
      }
    }, "collab-delete");
  }

  // Helper: set element fields inside a Y.Map so concurrent field updates merge
  // If replacePoints=true and element.points is an array, replace the Y.Array contents.
  private setElementYMap(
    element: ExcalidrawElement,
    opts?: { replacePoints?: boolean },
  ) {
    let ym = this.elementsMap.get(element.id) as Y.Map<any> | undefined;
    if (!ym) {
      ym = new Y.Map();
      this.elementsMap.set(element.id, ym);
      if (!this.orderArray.toArray().includes(element.id)) {
        this.orderArray.push([element.id]);
      }
    }
    // set/update fields; treat 'points' and 'text' specially
    Object.entries(element).forEach(([k, v]) => {
      if (k === "points") {
        if (opts?.replacePoints) {
          let ypoints = ym!.get("points") as Y.Array<any> | undefined;

          const arr = Array.isArray(v) ? v : [];
          const len = arr.length;
          const isStroke = this.isStrokeElement(element);

          // 🔒 For stroke-like elements, ignore point updates that don't have at least 2 points.
          if (isStroke && len < 2) {
            return;
          }

          if (!ypoints) {
            ypoints = new Y.Array();
            ym!.set("points", ypoints);
          } else {
            ypoints.delete(0, ypoints.length);
          }
          if (len > 0) {
            ypoints.push(arr);
          }
        } else {
          // if replacePoints not requested, ignore; incremental appends go via writePoints
        }
      } else if (k === "text") {
        // use Y.Text for collaborative text (if present as string)
        let ytext = ym!.get("text") as Y.Text | undefined;
        if (!ytext) {
          ytext = new Y.Text();
          ym!.set("text", ytext);
          if (typeof v === "string" && v.length > 0) {
            ytext.insert(0, v);
          }
        } else if (typeof v === "string") {
          // replace content with the string value for final commits
          ytext.delete(0, ytext.length);
          if (v.length > 0) {
            ytext.insert(0, v);
          }
        }
      } else {
        // normal field set
        ym!.set(k, v as any);
      }
    });
  }

  // Callback registration
  onElementsChanged(cb: ElementsChangeCallback) {
    this.onElementsCb = cb;

    // 🔹 Optional but useful: immediately emit current doc contents for late joiners
    try {
      const elements = this.readAllElements();
      if (elements && elements.length > 0) {
        cb(elements);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[yjsprovider] initial onElementsChanged failed", e);
    }
  }

  onAwareness(cb: AwarenessChangeCallback) {
    this.onAwarenessCb = cb;
  }

  private _onYChange = (_evt?: any) => {
    if (this.onElementsCb) {
      try {
        const elements = this.readAllElements();
        // eslint-disable-next-line no-console
        console.debug("[yjs] _onYChange -> readAllElements", {
          len: elements?.length ?? 0,
          ts: Date.now(),
          roomId: this.roomId,
        });
        this.onElementsCb(elements);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("YjsProvider _onYChange error", e);
      }
    }
  };

  private _onAwarenessChange = () => {
    if (!this.provider) {
      return;
    }
    const awareness = (this.provider as any).awareness;
    const states = new Map<number, any>(
      Array.from(awareness.getStates().entries()),
    );
    this.onAwarenessCb && this.onAwarenessCb(states);
  };

  // Expose some runtime info
  getStatus() {
    return {
      connected: !!this.provider && (this.provider as any).connected === true,
      provider: this.provider,
      doc: this.doc,
    };
  }

  // Helpful runtime helper for debug: returns an id identifying this client
  getClientID(): number | null {
    try {
      return (
        (this.provider as any)?.awareness?.clientID ??
        (this.doc as any).clientID ??
        null
      );
    } catch (_) {
      return null;
    }
  }
}
