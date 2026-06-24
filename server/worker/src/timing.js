export function createTimer() {
  let last = Date.now();
  const timings = {};
  return {
    mark(name) {
      const now = Date.now();
      timings[name] = now - last;
      last = now;
    },
    toObject() {
      return { ...timings };
    },
  };
}
