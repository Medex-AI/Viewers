import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

interface WallThicknessChartProps {
  series: (number | null)[];
  currentFrame: number;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length || payload[0]?.value == null) return null;
  return (
    <div className="rounded border border-gray-600 bg-gray-900 px-2 py-1 text-xs text-white">
      <p className="text-gray-400">Frame {label}</p>
      <p style={{ color: '#DD6B20' }}>Thickness: {payload[0].value?.toFixed(1)} mm</p>
    </div>
  );
};

const WallThicknessChart: React.FC<WallThicknessChartProps> = ({ series, currentFrame }) => {
  const hasData = series.some(v => v !== null);

  const data = series.map((v, i) => ({ frame: i, thickness: v }));

  return (
    <div data-testid="wall-thickness-chart">
      {!hasData ? (
        <div className="flex h-20 items-center justify-center rounded border border-gray-700 text-xs text-gray-500">
          Segment both LV Cavity and Myocardium to view this chart
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={100}>
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="frame" tick={{ fill: '#9CA3AF', fontSize: 10 }} />
            <YAxis
              tick={{ fill: '#9CA3AF', fontSize: 10 }}
              label={{ value: 'mm', angle: -90, position: 'insideLeft', fill: '#9CA3AF', fontSize: 10 }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Line
              type="monotone" dataKey="thickness" name="Wall"
              stroke="#DD6B20" dot={false} strokeWidth={2} connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
};

export default WallThicknessChart;
