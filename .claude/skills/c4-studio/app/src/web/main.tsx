import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@pw/ui/themes/precision-weave-neon.css';
import '@pw/ui/components.css';
import '@pw/ui/styles/glass.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { ThemeProvider, ToastProvider, TooltipProvider } from '@pw/ui/react';
import { App } from './app.tsx';
import { applySavedWidths } from './lib/resize.tsx';

applySavedWidths();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
