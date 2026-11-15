/** The centre pane: a factory screen or the focused page, by the view store. */
import { useEffect } from "react";
import { FocusView } from "../pages/FocusView.tsx";
import { BuilderView } from "./BuilderView.tsx";
import { PiAgentView } from "./PiAgentView.tsx";
import { useView, wireViewToSelection } from "./viewStore.ts";

export function FactoryCenter() {
  const view = useView();
  useEffect(() => wireViewToSelection(), []);
  switch (view) {
    case "builder":
      return <BuilderView />;
    case "pi-agent":
      return <PiAgentView />;
    default:
      return <FocusView />;
  }
}
