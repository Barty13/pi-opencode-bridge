# Thread root sandbox

This page covers the thread root sandbox: `OC_ROOT`, the path checks, the symlink rule, and the
git-backed root that rewind needs.

`OC_ROOT` sets the thread root. The code default is the working directory at Pi start
(`process.cwd()`); [environment.md](environment.md) lists it. The examples use `~/Pi`; set `OC_ROOT`
to the tree that you want. The bridge resolves the root with `realpathSync` at load. A missing root
does not stop the load; a call that needs the root reports the missing directory.

Two checks keep threads inside the root. `directory()` handles a create path. It joins the input to
the root, refuses a path outside the root, requires the path to exist, and compares the real path.
`oc_open` and `oc_fanout` use it. `assertLocal()` handles a thread id. It reads the thread's
`location.directory`, compares the real path, refuses a thread outside the root, and remembers the
result for that thread. Every tool that takes a session id calls it. `oc_attach` reads the thread row
for `underRoot()` first, then calls `assertLocal()`; every other session tool calls `assertLocal()`
before any other service call. `oc_models` takes no session id.

A thread outside the root is refused with `Thread ses_… sits in <dir>, outside <root>.` `directory()`
and `assertLocal()` compare real paths, so a symlink cannot pass a thread outside the root. The list
in `/oc` and the delete pass in `/oc-clean` filter the raw reported directory with `underRoot()`.

The root must be a git repository for `oc_rewind` to restore files. The bridge does not check this;
the service does. In a root without git, the stage answers HTTP 200 with `files: []`, the working
tree does not move, and the receipt says `no git history for this root, messages reverted, files untouched: <paths>` when the digest named paths; with no paths it says `files restored: none`. The
message half still works: `commit` removes the run's messages after the target, `clear` drops the
stage, and `branch` forks. The digest still names the paths that the run touched. Make the root a git
repository before the run if you need file restore.

Threads can write files. Point `OC_ROOT` at a scratch tree that you own.
