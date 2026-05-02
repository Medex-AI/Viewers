import React, { useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';

interface VolumeTimeCurveChartProps {
  lvSeries: number[];
  rvSeries: number[];
  edFrame: number;
  esFrame: number;
  currentFrame: number;
  onFrameClick?: (frameIndex: number) => void;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-gray-600 bg-gray-900 px-2 py-1 text-xs text-white">
      <p className="mb-1 text-gray-400">Frame {label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {p.value?.toFixed(1)} mL
        </p>
      ))}
    </div>
  );
};

const VolumeTimeCurveChart: React.FC<VolumeTimeCurveChartProps> = ({
  lvSeries, rvSeries, edFrame, esFrame, currentFrame, onFrameClick,
}) => {
  const maxLen = Math.max(lvSeries.length, rvSeries.length);
  const data = Array.from({ length: maxLen }, (_, i) => ({
    frame: i,
    lv: lvSeries[i] > 0 ? lvSeries[i] : null,
    rv: rvSeries[i] > 0 ? rvSeries[i] : null,
  }));

  const handleClick = useCallback((e: any) => {
    if (e?.activeLabel !== undefined && onFrameClick) {
      onFrameClick(Number(e.activeLabel));
    }
  }, [onFrameClick]);

  if (!maxLen) {
    return (
      <div
        className="flex h-32 items-center justify-center rounded border border-gray-700 text-xs text-gray-500"
        data-testid="vtc-chart"
      >
        Segment LV Cavity to populate the volume curve
      </div>
    );
  }

  return (
    <div data-testid="vtc-chart" className="cursor-pointer">
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} onClick={handleClick} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis
            dataKey="frame"
            tick={{ fill: '#9CA3AF', fontSize: 10 }}
            label={{ value: 'Frame', position: 'insideBottomRight', fill: '#9CA3AF', fontSize: 10 }}
          />
          <YAxis
            tick={{ fill: '#9CA3AF', fontSize: 10 }}
            label={{ value: 'mL', angle: -90, position: 'insideLeft', fill: '#9CA3AF', fontSize: 10 }}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 10, color: '#9CA3AF' }}
          />
          {edFrame >= 0 && (
            <ReferenceLine x={edFrame} stroke="#48BB78" strokeDasharray="4 2"
              label={{ value: 'ED', fill: '#48BB78', fontSize: 9 }} />
          )}
          {esFrame >= 0 && (
            <ReferenceLine x={esFrame} stroke="#ECC94B" strokeDasharray="4 2"
              label={{ value: 'ES', fill: '#ECC94B', fontSize: 9 }} />
          )}
          {currentFrame >= 0 && currentFrame !== edFrame && currentFrame !== esFrame && (
            <ReferenceLine x={currentFrame} stroke="#718096" strokeWidth={1} />
          )}
          <Line
            type="monotone" dataKey="lv" name="LV" stroke="#E53E3E"
            dot={false} strokeWidth={2} connectNulls={false} />
          <Line
            type="monotone" dataKey="rv" name="RV" stroke="#3182CE"
            dot={false} strokeWidth={2} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default VolumeTimeCurveChart;
