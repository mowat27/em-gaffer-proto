/** The centre pane: a factory screen or the focused page, by the view store. */
import { useEffect } from "react";
import { FocusView } from "../pages/FocusView.tsx";
import { GafferView } from "./GafferView.tsx";
import { OverviewView } from "./OverviewView.tsx";
import { useView, wireViewToSelection } from "./viewStore.ts";

export function FactoryCenter() {
  const view = useView();
  useEffect(() => wireViewToSelection(), []);
  switch (view) {
    case "overview":
      return <OverviewView />;
    case "gaffer":
      return <GafferView />;
    default:
      return <FocusView />;
  }
}
