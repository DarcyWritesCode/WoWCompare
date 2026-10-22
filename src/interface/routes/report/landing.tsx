import { useResults } from 'interface/report/Results/ResultsContext';
import ResultsLoadingIndicator from 'interface/report/Results/ResultsLoadingIndicator';
import TABS from 'interface/report/Results/TABS';
import ErrorBoundary from 'interface/ErrorBoundary';

import { Component as Overview } from './overview';

/** WoWCompare: open on Live Compare when the spec has one, else on the stock Overview. */
export function Component() {
  const { isLoading, results } = useResults();

  if (isLoading || !results) {
    return <ResultsLoadingIndicator />;
  }

  const liveCompare = results.tabs.find((tab) => tab.url === TABS.LIVE_COMPARE);
  if (!liveCompare) {
    return <Overview />;
  }
  return (
    <div className="container">
      <ErrorBoundary>{liveCompare.render()}</ErrorBoundary>
    </div>
  );
}
