import { createContext, useContext } from 'react';

export interface Ui {
  openNewModel: () => void;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  /** The chat fills the window as a modal overlay. */
  chatMax: boolean;
  setChatMax: (max: boolean) => void;
}

export const UiContext = createContext<Ui>({ openNewModel: () => undefined, chatOpen: false, setChatOpen: () => undefined, chatMax: false, setChatMax: () => undefined });
export const useUi = () => useContext(UiContext);
