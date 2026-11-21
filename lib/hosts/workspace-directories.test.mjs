import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { filePathApiSegments } from "../file-paths.ts";
import { workspaceHarness } from "./workspace-test-helper.mjs";

test("directory navigation and scratch creation stay on their host, and browsing grants no file access", async (t) => {
  const f = await workspaceHarness(); t.after(() => f.close());
  const owner = await f.startHost(), other = await f.startHost();
  const home = (await owner.host.workspaceOps.home()).value.home;
  const folder = join(home, "browse-only"); mkdirSync(folder); writeFileSync(join(folder,"private.txt"),"owning machine");
  const browsed = await owner.host.workspaceOps.browseDirectories("~"); assert.equal(browsed.ok,true); assert.equal(browsed.value.path,home); assert.ok(browsed.value.directories.some((x)=>x.path===folder));
  const input={segments:filePathApiSegments(folder),sessionId:null}; assert.equal((await owner.host.workspaceOps.listFiles(input,false)).status,403);
  await owner.host.sessionOps.validateCwd(folder); assert.equal((await owner.host.workspaceOps.listFiles(input,false)).ok,true); assert.equal((await other.host.workspaceOps.listFiles(input,false)).status,403);
  const first=await owner.host.workspaceOps.defaultCwd(),second=await owner.host.workspaceOps.defaultCwd();
  assert.equal(first.ok,true);assert.equal(second.ok,true);
  // Every chat gets a directory of its own under the chats root, so one chat's files stay out of the next one's context.
  const chatsRoot=join(home,".omp-chats");
  for(const scratch of [first,second]){assert.equal(dirname(scratch.value.cwd),chatsRoot);assert.equal(statSync(scratch.value.cwd).isDirectory(),true);}
  assert.notEqual(first.value.cwd,second.value.cwd);
  assert.equal((await owner.host.workspaceOps.listFiles({segments:filePathApiSegments(first.value.cwd),sessionId:null},false)).ok,true);
  assert.equal((await other.host.workspaceOps.listFiles({segments:filePathApiSegments(first.value.cwd),sessionId:null},false)).status,403);
});
