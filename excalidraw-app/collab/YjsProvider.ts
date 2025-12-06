/* excalidraw-app/collab/YjsProvider.ts
   Yjs provider wrapper with read + write helpers for Excalidraw elements.
   - init(roomId, wsUrl, opts)
   - writeElements(elements)
   - deleteElement(id)
   - onElementsChanged(cb)
   - onAwareness(cb)
   - getStatus()
   - destroy()
   
   Requires: yjs, y-websocket, y-indexeddb
   npm install yjs y-websocket y-indexeddb
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
  }

  async init(roomId: string, wsUrl: string, opts: YjsProviderOpts = {}) {
    this.roomId = roomId;

    if (opts.persist) {
      try {
        this.indexeddb = new IndexeddbPersistence(`excalidraw-${roomId}`, this.doc);
        await this.indexeddb.whenSynced;
      } catch (e) {
        console.warn("IndexeddbPersistence init failed", e);
      }
    }

    // WebsocketProvider expects a "url" and a room name
    // wsUrl should be something like ws://host:1234
    this.provider = new WebsocketProvider(wsUrl, roomId, this.doc, { connect: true });

    // Observe changes
    this.elementsMap.observe(this._onYChange);
    this.orderArray.observe(this._onYChange);

    // Awareness
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
    // Do not call this.doc.destroy() in case other code still references it.
    this.roomId = null;
  }

  // Convert Y.Map -> ExcalidrawElement
  private yMapToElement(id: string, ymap: Y.Map<any>): ExcalidrawElement {
    const el: any = { id };
    ymap.forEach((v: any, k: string) => {
      el[k] = v;
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
        if (ym) out.push(this.yMapToElement(id, ym));
      }
    } else {
      this.elementsMap.forEach((ym: Y.Map<any>, id: string) => {
        out.push(this.yMapToElement(id, ym));
      });
    }
    return out;
  }

  // Write many elements in a transaction. Each element becomes a Y.Map stored at elementsMap[id].
  writeElements(elements: ExcalidrawElement[]) {
    this.doc.transact(() => {
      for (const element of elements) {
        this.setElementYMap(element);
      }
    }, this);
  }

  // Delete an element (remove from map and order array)
  deleteElement(id: string) {
    this.doc.transact(() => {
      this.elementsMap.delete(id);
      // remove from order array if present
      const arr = this.orderArray.toArray();
      const idx = arr.indexOf(id);
      if (idx !== -1) {
        this.orderArray.delete(idx, 1);
      }
    }, this);
  }

  // Helper: set element fields inside a Y.Map so concurrent field updates merge
  private setElementYMap(element: ExcalidrawElement) {
    let ym = this.elementsMap.get(element.id) as Y.Map<any> | undefined;
    if (!ym) {
      ym = new Y.Map();
      this.elementsMap.set(element.id, ym);
      // ensure order
      if (!this.orderArray.toArray().includes(element.id)) {
        this.orderArray.push([element.id]);
      }
    }
    // set/update fields
    Object.entries(element).forEach(([k, v]) => {
      ym!.set(k, v as any);
    });
  }

  // Callback registration
  onElementsChanged(cb: ElementsChangeCallback) {
    this.onElementsCb = cb;
  }

  onAwareness(cb: AwarenessChangeCallback) {
    this.onAwarenessCb = cb;
  }

  private _onYChange = (_evt?: any) => {
    if (this.onElementsCb) {
      try {
        const elements = this.readAllElements();
        this.onElementsCb(elements);
      } catch (e) {
        console.error("YjsProvider _onYChange error", e);
      }
    }
  };

  private _onAwarenessChange = () => {
    if (!this.provider) return;
    const awareness = (this.provider as any).awareness;
    const states = new Map<number, any>(Array.from(awareness.getStates().entries()));
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
}