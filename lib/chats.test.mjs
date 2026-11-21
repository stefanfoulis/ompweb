import assert from "node:assert/strict";
import test from "node:test";

const { CHATS_ROOT_DIRNAME, chatsRootOf, isChatDirectory, isChatsRoot } = await import("./chats.ts");

test("a chat directory is one level under the chats root in a home directory", () => {
  assert.equal(CHATS_ROOT_DIRNAME, ".omp-chats");
  assert.equal(chatsRootOf("/home/me/.omp-chats/2026-11-21-Ab3xZ9"), "/home/me/.omp-chats");
  assert.equal(chatsRootOf("/home/me/.omp-chats/2026-11-21-Ab3xZ9/"), "/home/me/.omp-chats");
  assert.equal(chatsRootOf("C:\\Users\\me\\.omp-chats\\2026-11-21-Ab3xZ9"), "C:\\Users\\me\\.omp-chats");
  assert.equal(isChatDirectory("/home/me/.omp-chats/2026-11-21-Ab3xZ9"), true);
});

test("a workspace, the chats root itself and paths inside a chat are not chat directories", () => {
  for (const path of [
    "/home/me/code/ompweb",
    "/home/me/.omp-chats",
    // The chats root holds the chat directories; a directory the agent made
    // inside one is part of that chat, not a chat of its own.
    "/home/me/.omp-chats/2026-11-21-Ab3xZ9/notes",
    // Relative: a `.omp-chats` the user happens to have somewhere else.
    ".omp-chats/2026-11-21-Ab3xZ9",
  ]) {
    assert.equal(chatsRootOf(path), null, path);
    assert.equal(isChatDirectory(path), false, path);
  }
});

test("the chats root is recognized on its own, with either separator", () => {
  assert.equal(isChatsRoot("/home/me/.omp-chats"), true);
  assert.equal(isChatsRoot("/home/me/.omp-chats/"), true);
  assert.equal(isChatsRoot("C:\\Users\\me\\.omp-chats"), true);
  assert.equal(isChatsRoot("/home/me/.omp-chats/2026-11-21-Ab3xZ9"), false);
  assert.equal(isChatsRoot("/home/me/code/ompweb"), false);
});
