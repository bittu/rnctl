import { Box, Text, render } from 'ink';
import { createElement } from 'react';

/** Renders the placeholder mission-control dashboard. */
export function renderDashboard(): void {
  const app = createElement(
    Box,
    { flexDirection: 'column', padding: 1 },
    createElement(Text, { bold: true, color: 'cyan' }, 'rnctl - Mission Control'),
    createElement(Text, null, 'Daemon connected. Press Ctrl+C to quit.'),
  );
  render(app);
}
