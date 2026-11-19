import { useCallback, useMemo, useState } from 'react';
import { Alert, SkipLink } from '@pw/ui/react';
import { ChatPanel } from './chat/ChatPanel.tsx';
import { NewModelDialog } from './dialogs/NewModelDialog.tsx';
import { AdrsPage } from './pages/AdrsPage.tsx';
import { ComparePage } from './pages/ComparePage.tsx';
import { DiagramPage } from './pages/DiagramPage.tsx';
import { HistoryPage } from './pages/HistoryPage.tsx';
import { JobsPage } from './pages/JobsPage.tsx';
import { AgentPage } from './pages/AgentPage.tsx';
import { StatusBar } from './panels/StatusBar.tsx';
import { Header } from './panels/Header.tsx';
import { StudioProvider, useStudio } from './state/studio.tsx';
import { UiContext } from './state/ui.tsx';

function ParseErrorAlert() {
  const { bs } = useStudio();
  if (!bs || bs.workspace || !bs.parseError) return null;
  return (
    <Alert tone="error" title={`The DSL does not parse (line ${bs.parseError.line})`} className="c4-parse-alert">
      {bs.parseError.message}. The diagram shows the last version that parsed. Fix workspace.dsl, or roll back from History.
    </Alert>
  );
}

function Page() {
  const { url, loadError, models } = useStudio();
  if (loadError && !models) return <Alert tone="error" title="Could not reach the C4 Studio server">{loadError}</Alert>;
  switch (url.page) {
    case 'history':
      return <HistoryPage />;
    case 'compare':
      return <ComparePage />;
    case 'adrs':
      return <AdrsPage />;
    case 'jobs':
      return <JobsPage />;
    case 'agent':
      return <AgentPage />;
    default:
      return <DiagramPage />;
  }
}

// Whether the chat panel is open, per browser, so a refresh keeps it as it was.
const CHAT_OPEN_KEY = 'c4studio.chatOpen';
function readChatOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function Shell() {
  const [chatOpen, setOpen] = useState(readChatOpen);
  const [chatMax, setChatMax] = useState(false);
  const [newModel, setNewModel] = useState(false);
  const setChatOpen = useCallback((open: boolean) => {
    setOpen(open);
    if (!open) setChatMax(false);
    try {
      localStorage.setItem(CHAT_OPEN_KEY, open ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, []);
  const ui = useMemo(() => ({ openNewModel: () => setNewModel(true), chatOpen, setChatOpen, chatMax, setChatMax }), [chatOpen, setChatOpen, chatMax]);
  // While the chat is maximised it is modal: everything behind it is inert.
  const behind = chatMax || undefined;
  return (
    <UiContext.Provider value={ui}>
      <div className="c4-app">
        <div className="c4-contents" inert={behind}>
          <SkipLink href="#main">Skip to the main content</SkipLink>
          <Header />
          <ParseErrorAlert />
        </div>
        <div className="c4-body" data-chat={chatOpen || undefined}>
          <main id="main" className="c4-main" inert={behind}>
            <Page />
          </main>
          <ChatPanel />
        </div>
        <div className="c4-contents" inert={behind}>
          <StatusBar />
        </div>
        <NewModelDialog open={newModel} onOpenChange={setNewModel} />
      </div>
    </UiContext.Provider>
  );
}

export function App() {
  return (
    <StudioProvider>
      <Shell />
    </StudioProvider>
  );
}
