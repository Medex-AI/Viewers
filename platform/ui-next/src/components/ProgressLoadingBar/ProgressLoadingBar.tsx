import React, { ReactElement } from 'react';

import './ProgressLoadingBar.css';

export type ProgressLoadingBarProps = {
  progress?: number;
};
/**
 * A React component that renders a loading progress bar.
 * If progress is not provided, it will render an infinite loading bar
 * If progress is provided, it will render a progress bar
 * The progress text can be optionally displayed to the left of the bar.
 */
function ProgressLoadingBar({ progress }: ProgressLoadingBarProps): ReactElement {
  return (
    <div className="loading">
      {progress === undefined || progress === null ? (
        <div
          className="infinite-loading-bar"
          style={{ backgroundColor: '#F47620' }}
        ></div>
      ) : (
        <div
          style={{
            width: `${progress}%`,
            height: '8px',
            backgroundColor: '#F47620',
          }}
        ></div>
      )}
    </div>
  );
}

export default ProgressLoadingBar;
