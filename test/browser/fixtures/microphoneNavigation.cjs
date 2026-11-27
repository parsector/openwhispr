const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { app, BrowserWindow } = require("electron");
const { createMicrophoneCaptureOwner } = require("../../../src/helpers/microphoneCaptureOwner");

// Bound startup and every renderer/server await even if Electron stops responding.
setTimeout(() => {
  console.error("navigation teardown proof timed out");
  app.exit(1);
}, 20_000).unref();

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("disable-gpu");

app
  .whenReady()
  .then(async () => {
    const server = http.createServer((req, res) => {
      if (req.url !== "/pending") res.end("<!doctype html><title>Capture</title>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      const win = new BrowserWindow({ show: false });
      const owner = createMicrophoneCaptureOwner();
      const contender = new BrowserWindow({ show: false });
      await win.loadURL(url);
      assert.equal(owner.acquire(win.webContents, "recording"), true);
      await win.webContents.executeJavaScript(`(async () => {
      globalThis.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      globalThis.track = stream.getAudioTracks()[0];
      window.open('${url}/observer');
      })()`);
      const [observer] = BrowserWindow.getAllWindows().filter((w) => w !== win && w !== contender);
      if (observer.webContents.isLoading()) await once(observer.webContents, "did-finish-load");
      await observer.webContents.executeJavaScript("globalThis.oldTrack = opener.track");
      assert.equal(await observer.webContents.executeJavaScript("oldTrack.readyState"), "live");

      await win.webContents.executeJavaScript("location.hash = 'same-document'");
      assert.equal(await observer.webContents.executeJavaScript("oldTrack.readyState"), "live");
      assert.equal(owner.acquire(contender.webContents, "same-document"), false);

      // Start a real navigation whose response cannot commit. Its old document
      // still owns input, and remains alive even when navigation is aborted.
      const navigating = once(win.webContents, "did-start-navigation");
      await win.webContents.executeJavaScript(`location.href = '${url}/pending'`);
      await navigating;
      assert.equal(await observer.webContents.executeJavaScript("oldTrack.readyState"), "live");
      assert.equal(
        owner.acquire(contender.webContents, "next"),
        false,
        "navigation intent cannot admit capture while the old document has live input"
      );
      win.webContents.stop();
      assert.equal(await observer.webContents.executeJavaScript("oldTrack.readyState"), "live");
      assert.equal(owner.acquire(contender.webContents, "next"), false);

      await win.loadURL(`${url}/replacement`);
      assert.equal(
        await observer.webContents.executeJavaScript("oldTrack.readyState"),
        "ended",
        "committed replacement must destroy the old document's capture"
      );
      assert.equal(owner.acquire(contender.webContents, "next"), true);
      console.log("navigation teardown proved with a real MediaStreamTrack");
    } finally {
      server.close();
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    }
  );
