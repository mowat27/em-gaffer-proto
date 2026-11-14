/** The centre pane: a factory screen or the focused page, by the view store. */
import { useEffect } from "react";
import { FocusView } from "../pages/FocusView.tsx";
import { BuilderView } from "./BuilderView.tsx";
import { GafferView } from "./GafferView.tsx";
import { OverviewView } from "./OverviewView.tsx";
import { PiAgentView } from "./PiAgentView.tsx";
import { PiTerminalView } from "./PiTerminalView.tsx";
import { useView, wireViewToSelection } from "./viewStore.ts";

export function FactoryCenter() {
  const view = useView();
  useEffect(() => wireViewToSelection(), []);
  switch (view) {
    case "overview":
      return <OverviewView />;
    case "gaffer":
      return <GafferView />;
    case "builder":
      return <BuilderView />;
    case "pi-agent":
      return <PiAgentView />;
    case "pi-terminal":
      return <PiTerminalView />;
    default:
      return <FocusView />;
  }
}
