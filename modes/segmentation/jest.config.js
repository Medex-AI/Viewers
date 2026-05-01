const base = require('../../jest.config.base.js');
const pkg = require('./package');
const path = require('path');

module.exports = {
  ...base,
  name: pkg.name,
  displayName: pkg.name,
  testMatch: [
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/src/**/*.test.tsx',
    '<rootDir>/src/**/*.test.js',
  ],
  transform: {
    '^.+\\.(ts|tsx|js|jsx|mjs)$': [
      'babel-jest',
      { configFile: path.resolve(__dirname, '../../babel.config.js') },
    ],
  },
  // Allow babel-jest to transform ESM packages from node_modules
  transformIgnorePatterns: [
    'node_modules/(?!(@cornerstonejs|@ohif)/)',
  ],
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '@ohif/(.*)': '<rootDir>/../../platform/$1/src',
    '@medex/(.*)': '<rootDir>/../../medex/$1/src',
    // ESM-only packages — map to their dist entry since there's no `main` field
    '@cornerstonejs/core': '<rootDir>/../../node_modules/@cornerstonejs/core/dist/esm/index.js',
    '@cornerstonejs/tools': '<rootDir>/../../node_modules/@cornerstonejs/tools/dist/esm/index.js',
  },
};
