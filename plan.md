1. **Understand the Goal**: The task requires adding a test for WebGL renderer exception handling when `document.createElement('canvas').getContext` throws an error. We want to mock `canvas.getContext` so that it throws an exception, and check that `getGpuRenderer` (accessed indirectly via `detectCapabilities` or testing `probeGPU` depending on what is exported) gracefully returns 'unknown' or handles the exception.
2. **Examine `src/performance.test.ts`**: The file already has an `it('handles WebGL renderer exception gracefully')` that throws when `createElement('canvas')` is called. However, the task specifically says: *"A straightforward mock of `document.createElement('canvas').getContext` to throw an error, confirming the function catches it and returns 'unknown'."*
So we need to mock `getContext` on the canvas element to throw an error, not `createElement`.
3. **Change the test**: Modify the existing `handles WebGL renderer exception gracefully` test or add a new one specifically for `getContext` throwing an error.
4. **Code changes**:
   Update `src/performance.test.ts` to mock `getContext` to throw an error.
5. **Verify**: Run `npm run test src/performance.test.ts` to make sure it passes.
