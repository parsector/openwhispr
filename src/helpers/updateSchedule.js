const STARTUP_DELAY_MS = 30_000;
const ENABLE_DELAY_MS = 3_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function shouldSchedule({ enabled, packaged, supported, development, stopped }) {
  return enabled && packaged && supported && !development && !stopped;
}

function shouldCheck(state) {
  return shouldSchedule(state) && !state.inFlight && !state.downloaded;
}

function delayFor(reason) {
  if (reason === "startup") return STARTUP_DELAY_MS;
  if (reason === "enabled") return ENABLE_DELAY_MS;
  return CHECK_INTERVAL_MS;
}

module.exports = { shouldSchedule, shouldCheck, delayFor };
