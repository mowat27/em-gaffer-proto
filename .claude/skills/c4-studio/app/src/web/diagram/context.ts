import { createContext, useContext } from 'react';

export interface CanvasCtx {
  selectedElement?: string;
  selectedRel?: string;
  readOnly: boolean;
  selectRel: (id: string) => void;
  /** Open the view one level below an element; absent on read-only canvases. */
  drill?: (viewKey: string, elementId: string) => void;
  /** Collapse or show one relationship's label; absent on read-only canvases. */
  toggleLabel?: (relId: string, collapsed: boolean) => void;
}

export const CanvasContext = createContext<CanvasCtx>({ readOnly: true, selectRel: () => undefined });
export const useCanvasCtx = () => useContext(CanvasContext);
