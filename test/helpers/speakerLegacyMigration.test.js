const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const createTempDir = require('../lib/tempDir');
let dir;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return {app: {getPath:()=>dir,getAppPath:()=>process.cwd(),isReady:()=>false}};
  return originalLoad.call(this,request,parent,isMain);
};
process.env.NODE_ENV='test';
const DatabaseManager=require('../../src/helpers/database');
Module._load=originalLoad;
const {readTranscriptDocument}=require('../../src/helpers/transcriptDocument');
function fixture(t) {
  dir=createTempDir(path.join(os.tmpdir(),'ow-legacy-migration-'));
  const root=dir;
  const db=new DatabaseManager();
  t.after(()=>{db.db.close();fs.rmSync(root,{recursive:true,force:true});});
  return {db,note(title,rows){const id=db.saveNote(title,'','meeting').note.id;
    db.updateNote(id,{transcript:JSON.stringify({version:2,rows})});return id;}};
}

test('run6: startup legacy migration records Unknown once and preserves human choices',t=>{
  const f=fixture(t);if(!f)return;
  const note=f.note('legacy',[],[]);
  const rows=[{id:'auto',text:'auto',source:'system',speakerName:'Outsider'},{id:'human',text:'human',source:'system',speakerName:'Chosen',speakerLockSource:'user'}];
  f.db.db.prepare('UPDATE notes SET transcript = ?, participants = ? WHERE id = ?').run(JSON.stringify(rows),'[{"email":"a@example.com"}]',note);
  f.db.db.prepare('UPDATE notes SET account_id = ? WHERE id = ?').run('inactive-account',note);
  assert.equal(f.db.getNote(note),null);
  const reopened=new DatabaseManager();t.after(()=>reopened.db.close());
  const stored=reopened.db.prepare('SELECT transcript FROM notes WHERE id = ?').get(note).transcript;
  const actual=readTranscriptDocument(stored).rows;
  assert.equal(actual[0].speakerName,undefined);
  assert.equal(actual[0].speakerDecision.rejectionReason,'legacy_not_evaluated');
  assert.equal(actual[0].speakerDecision.acousticEvaluation,'not_evaluated');
  assert.equal(actual[0].speakerDecision.noteId,note,'startup must use the stored roster even before its account becomes active');
  assert.equal(actual[0].speakerReviewRequired,true);
  assert.equal(actual[1].speakerName,'Chosen');
  const again=new DatabaseManager();t.after(()=>again.db.close());
  assert.equal(again.db.prepare('SELECT transcript FROM notes WHERE id = ?').get(note).transcript,stored);
});

test('run6: bulk import installs through the legacy policy before the first read',t=>{
  const f=fixture(t);if(!f)return;
  const imported=f.db.importNotes([{clientNoteId:'run6-import',title:'import',content:'',participants:'[{"email":"a@example.com"}]',transcript:JSON.stringify([{id:'row',text:'hello',source:'system',speakerName:'Outsider'}])}]);
  assert.equal(imported.imported,1);
  const raw=readTranscriptDocument(f.db.db.prepare('SELECT transcript FROM notes WHERE id = ?').get(imported.noteIds[0]).transcript).rows[0];
  assert.equal(raw.speakerName,undefined);
  assert.equal(raw.speakerDecision.rejectionReason,'legacy_not_evaluated');
});
