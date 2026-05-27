module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/test/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
};
