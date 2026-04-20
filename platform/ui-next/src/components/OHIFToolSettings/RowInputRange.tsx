import React from 'react';
import Numeric from '../Numeric';
import { cn } from '../../lib/utils';

interface RowInputRangeProps {
  value: number;
  onChange: (newValue: number) => void;
  minValue?: number;
  maxValue?: number;
  step?: number;
  label?: string;
  showLabel?: boolean;
  labelPosition?: 'left' | 'right';
  allowNumberEdit?: boolean;
  showNumberInput?: boolean;
  className?: string;
  containerClassName?: string;
  showInlineAdjustmentButtons?: boolean;
}

const RowInputRange: React.FC<RowInputRangeProps> = ({
  value,
  onChange,
  minValue = 0,
  maxValue = 100,
  step = 1,
  label = '',
  showLabel = false,
  labelPosition = 'right',
  allowNumberEdit = false,
  showNumberInput = true,
  className,
  containerClassName,
  showInlineAdjustmentButtons = false,
}) => {
  const handleChange = (newValue: number | [number, number]) => {
    if (typeof newValue === 'number') {
      onChange(newValue);
    } else {
      onChange(newValue[0]);
    }
  };

  const adjustValue = (delta: number) => {
    const nextValue = Math.min(maxValue, Math.max(minValue, value + delta));
    onChange(nextValue);
  };

  const content = (
    <div className={cn('flex items-center gap-2', className)}>
      {showInlineAdjustmentButtons && (
        <button
          type="button"
          className="border-input bg-background hover:bg-accent hover:text-accent-foreground h-7 w-7 rounded border text-base leading-none"
          onClick={() => adjustValue(-step)}
          aria-label={`Decrease ${label || 'value'}`}
        >
          -
        </button>
      )}
      <Numeric.Container
        mode="singleRange"
        value={value}
        onChange={handleChange}
        min={minValue}
        max={maxValue}
        step={step}
        className="flex min-w-0 flex-1 flex-row items-center space-x-2"
      >
        {showLabel && label && labelPosition === 'left' && (
          <Numeric.Label showValue={showNumberInput}>{label}</Numeric.Label>
        )}
        <Numeric.SingleRange
          showNumberInput={allowNumberEdit && showNumberInput}
          beforeNumberInput={
            showInlineAdjustmentButtons ? (
              <button
                type="button"
                className="border-input bg-background hover:bg-accent hover:text-accent-foreground h-7 w-7 rounded border text-base leading-none"
                onClick={() => adjustValue(step)}
                aria-label={`Increase ${label || 'value'}`}
              >
                +
              </button>
            ) : null
          }
        />
        {showLabel && label && labelPosition === 'right' && (
          <Numeric.Label showValue={showNumberInput}>{label}</Numeric.Label>
        )}
      </Numeric.Container>
    </div>
  );

  return containerClassName ? <div className={containerClassName}>{content}</div> : content;
};

export default RowInputRange;
