const MAX_UNDO = 50;

/**
 * @param {() => object | null} capture
 * @param {(snap: object) => void} restore
 */
export function createUndoManager(capture, restore) {
  const stack = [];
  let restoring = false;
  let typingLatch = false;
  let typingTimer = null;

  function snapshotsEqual(a, b) {
    if (!a || !b) return false;
    return (
      a.lastStyledHtml === b.lastStyledHtml &&
      a.plainText === b.plainText &&
      a.timelineTime === b.timelineTime &&
      JSON.stringify(a.state) === JSON.stringify(b.state)
    );
  }

  return {
    isRestoring() {
      return restoring;
    },

    push() {
      if (restoring) return;
      const snap = capture();
      if (!snap) return;
      const prev = stack[stack.length - 1];
      if (prev && snapshotsEqual(prev, snap)) return;
      stack.push(snap);
      if (stack.length > MAX_UNDO) stack.shift();
    },

    undo() {
      if (stack.length === 0) return false;
      restoring = true;
      try {
        restore(stack.pop());
      } finally {
        restoring = false;
      }
      return true;
    },

    canUndo() {
      return stack.length > 0;
    },

    /** Call before a typing burst in the editor (once per burst). */
    noteTypingStart() {
      if (restoring || typingLatch) return;
      typingLatch = true;
      this.push();
    },

    noteTypingEnd() {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        typingLatch = false;
      }, 600);
    },

    reset() {
      stack.length = 0;
      typingLatch = false;
    },
  };
}
