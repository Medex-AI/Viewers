import React, { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import Typography from '../Typography';
import { Icons } from '@ohif/ui-next';

const isTouchCapableDevice = () =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

const ContextMenu = ({ items, ...props }) => {
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const isTabletMode = isTouchCapableDevice();
  useEffect(() => {
    if (!contextMenuRef?.current) {
      return;
    }

    const contextMenu = contextMenuRef.current;

    const boundingClientRect = contextMenu.getBoundingClientRect();
    if (boundingClientRect.bottom > window.innerHeight) {
      props.defaultPosition.y = props.defaultPosition.y - boundingClientRect.height;
    }
    if (boundingClientRect.right > window.innerWidth) {
      props.defaultPosition.x = props.defaultPosition.x - boundingClientRect.width;
    }
  }, [props.defaultPosition]);

  if (!items) {
    return null;
  }

  return (
    <div
      ref={contextMenuRef}
      data-cy="context-menu"
      className="bg-secondary-dark relative z-50 block w-52 select-none overflow-hidden rounded-2xl shadow-2xl"
      onContextMenu={e => e.preventDefault()}
      onMouseDown={e => e.preventDefault()}
      onTouchStart={e => e.preventDefault()}
      style={{
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        animation: isTabletMode ? 'ohif-context-menu-pop 160ms cubic-bezier(0.2, 0.8, 0.2, 1)' : undefined,
        transformOrigin: isTabletMode ? 'top left' : undefined,
        backdropFilter: isTabletMode ? 'blur(10px)' : undefined,
      }}
    >
      <style>
        {`
          @keyframes ohif-context-menu-pop {
            0% {
              opacity: 0;
              transform: translateY(10px) scale(0.96);
            }
            100% {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }
        `}
      </style>
      {items.map((item, index) => (
        <div
          key={index}
          data-cy="context-menu-item"
          onClick={() => item.action(item, props)}
          onTouchEnd={e => {
            e.preventDefault();
            item.action(item, props);
          }}
          style={{ justifyContent: 'space-between', borderRadius: 0 }}
          className="hover:bg-primary-dark border-primary-dark flex cursor-pointer select-none items-center rounded-none border-b px-4 py-3.5 transition duration-200 last:border-b-0"
        >
          <Typography>{item.label}</Typography>
          {item.iconRight && (
            <Icons.ByName
              name={item.iconRight}
              className="inline text-white"
            />
          )}
        </div>
      ))}
    </div>
  );
};

ContextMenu.propTypes = {
  defaultPosition: PropTypes.shape({
    x: PropTypes.number,
    y: PropTypes.number,
  }),
  items: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.string.isRequired,
      action: PropTypes.func.isRequired,
    })
  ),
};

export default ContextMenu;
