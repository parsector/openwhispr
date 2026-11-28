// Leave stdout/stderr inherited so the test can distinguish stdin EOF from a
// broken output pipe. SIGKILL closes only the parent's stdin writer.
const { spawn } = require("node:child_process");
const child = spawn(process.argv[2], [], { stdio: ["pipe", "inherit", "inherit"] });
child.on("spawn", () => process.send({ pid: child.pid }));
setInterval(() => {}, 1000);
