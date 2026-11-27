// Main-process admission for every renderer that opens an input device. The
// existing dictation/agent admission still runs first; this also covers meetings
// and short permission probes, which do not pass through those UI gates.
function createMicrophoneCaptureOwner() {
  let owner = null;

  const release = (sender, id) => {
    if (!owner || owner.sender !== sender || owner.id !== id) return false;
    sender.removeListener("destroyed", owner.onLost);
    sender.removeListener("render-process-gone", owner.onLost);
    sender.removeListener("did-navigate", owner.onNavigation);
    owner = null;
    return true;
  };

  const acquire = (sender, id) => {
    if (typeof id !== "string" || !id || sender.isDestroyed?.()) return false;
    if (owner) return owner.sender === sender && owner.id === id;
    const onLost = () => release(sender, id);
    // did-navigate follows a committed main-frame document replacement. Intent
    // (did-start-navigation) can be aborted while the old input stays alive;
    // in-page navigation does not emit did-navigate.
    const onNavigation = onLost;
    owner = { sender, id, onLost, onNavigation };
    sender.once("destroyed", onLost);
    sender.once("render-process-gone", onLost);
    sender.on("did-navigate", onNavigation);
    return true;
  };

  return { acquire, release };
}

module.exports = { createMicrophoneCaptureOwner };
