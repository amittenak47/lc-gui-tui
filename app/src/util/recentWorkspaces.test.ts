import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {loadRecentWorkspaces,rememberRecentWorkspace,visibleRecentWorkspaces,RECENT_WORKSPACES_KEY,RECENT_WORKSPACE_LIMIT} from "./recentWorkspaces";
import {tabsReducer,initialTabState,type AnnotateTab,type TabRecord} from "./tabs";
const library=vi.hoisted(()=>({docs:[] as any[],books:[] as any[]}));
vi.mock('./annotateStore',()=>({listAnnotateDocs:()=>library.docs.filter(d=>!d.deletedAt),getAnnotateDocMeta:(id:string)=>library.docs.find(d=>d.id===id)??null}));
vi.mock('./whiteboardStore',()=>({listWhiteboardNotebooks:()=>library.books.filter(b=>!b.deletedAt)}));
beforeEach(()=>{
  const values=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value)});
  library.docs=[];library.books=[];
});
afterEach(()=>vi.unstubAllGlobals());
const pdf=(id='pdf',extra:Partial<AnnotateTab>={}):AnnotateTab=>({id,kind:'annotate',title:'Algorithms.pdf',docType:'pdf',docId:null,hash:'pdf-hash',source:null,indexed:'indexing',dirty:true,lastActive:1,...extra});
it('retains visited work after its tab closes and excludes every currently open item',()=>{
  const doc=pdf();let state=tabsReducer(initialTabState(),{type:'open',tab:doc,at:10});
  rememberRecentWorkspace(state.tabs[1]);
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),state.tabs)).toEqual([]);
  state=tabsReducer(state,{type:'close',id:doc.id});
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),state.tabs)).toMatchObject([{title:'Algorithms.pdf',hash:'pdf-hash',dirty:false}]);
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),[pdf('other-id')])).toEqual([]);
});
it('keeps visits newest first, deduplicates entities, and bounds history',()=>{
  for(let i=0;i<20;i++)rememberRecentWorkspace(pdf('tab-'+i,{hash:'hash-'+i,lastActive:i}));
  expect(loadRecentWorkspaces()).toHaveLength(RECENT_WORKSPACE_LIMIT);
  rememberRecentWorkspace(pdf('reopened',{hash:'hash-12',lastActive:30,title:'Reopened'}));
  expect(loadRecentWorkspaces()[0].title).toBe('Reopened');
  expect(loadRecentWorkspaces().filter(t=>t.kind==='annotate'&&t.hash==='hash-12')).toHaveLength(1);
  const write=vi.spyOn(localStorage,'setItem');rememberRecentWorkspace(loadRecentWorkspaces()[0]);expect(write).not.toHaveBeenCalled();
});
it('updates a read-only session when it gains a library id without merging annotation forks',()=>{
  rememberRecentWorkspace(pdf('same-tab'));
  rememberRecentWorkspace(pdf('same-tab',{docId:'set-a'}));
  rememberRecentWorkspace(pdf('fork',{docId:'set-b'}));
  expect(loadRecentWorkspaces()).toHaveLength(2);
  library.docs=[{id:'set-a',name:'A.pdf'},{id:'set-b',name:'B.pdf'}];
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),[pdf('open-a',{docId:'set-a'})])).toMatchObject([{docId:'set-b'}]);
});
it('retains earlier problems and addresses when the same tab is reused',()=>{
  const first:TabRecord={id:'practice',kind:'practice',dataset:'bank',taskId:'1',title:'First problem',dirty:false,lastActive:1};
  const second={...first,taskId:'2',title:'Second problem',lastActive:2};
  rememberRecentWorkspace(first);rememberRecentWorkspace(second);
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),[second])).toMatchObject([{taskId:'1'}]);
  const web:TabRecord={id:'web',kind:'web',docId:null,title:'First page',dirty:false,indexed:'idle',lastActive:3,index:0,entries:[{url:'https://first.example',title:'First page',html:'payload'}]};
  const next:TabRecord={...web,title:'Next page',entries:[{url:'https://next.example',title:'Next page',html:'payload'}],lastActive:4};
  rememberRecentWorkspace(web);rememberRecentWorkspace(next);
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),[next]).filter(t=>t.kind==='web')).toMatchObject([{entries:[{url:'https://first.example'}]}]);
});
it('follows renames and hides trashed and removed notebooks/documents',()=>{
  rememberRecentWorkspace(pdf('saved',{docId:'saved'}));
  library.docs=[{id:'saved',name:'Algorithms.pdf',label:'Exam notes'}];
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),[])[0].title).toBe('Exam notes');
  library.docs[0].deletedAt=123;
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),[])).toEqual([]);
  const book:TabRecord={id:'book-tab',kind:'whiteboard',notebookId:'book',title:'Old',dirty:false,lastActive:2};
  rememberRecentWorkspace(book);library.books=[{id:'book',title:'Renamed'}];
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),[])[0].title).toBe('Renamed');
  library.books=[];expect(visibleRecentWorkspaces(loadRecentWorkspaces(),[])).toEqual([]);
});
it('keeps read-only text with a minted id and retains only the current Web address',()=>{
  rememberRecentWorkspace(pdf('read',{docId:'not-yet-saved',docType:'markdown',source:'Read-only text'}));
  expect(loadRecentWorkspaces()[0]).toMatchObject({source:'Read-only text'});
  expect(visibleRecentWorkspaces(loadRecentWorkspaces(),[])).toHaveLength(1);
  rememberRecentWorkspace({id:'web',kind:'web',title:'Current',docId:null,dirty:true,indexed:'idle',lastActive:3,group:'old-split',index:1,entries:[{url:'https://old.example',title:'Old',html:'old-payload'},{url:'https://example.com',title:'Current',html:'heavy-payload'}]});
  expect(loadRecentWorkspaces()[0]).toMatchObject({kind:'web',entries:[{url:'https://example.com',html:''}],index:0,dirty:false});
  expect(loadRecentWorkspaces()[0].group).toBeUndefined();
  expect(localStorage.getItem(RECENT_WORKSPACES_KEY)).not.toContain('heavy-payload');
});
it('rejects malformed storage and excludes transient, owned attachment and blank workspaces',()=>{
  localStorage.setItem(RECENT_WORKSPACES_KEY,'{broken');expect(loadRecentWorkspaces()).toEqual([]);
  rememberRecentWorkspace(initialTabState().tabs[0]);
  rememberRecentWorkspace({id:'blank',kind:'whiteboard',notebookId:null,title:'Blank',dirty:false,lastActive:1});
  expect(loadRecentWorkspaces()).toEqual([]);
  localStorage.setItem(RECENT_WORKSPACES_KEY,JSON.stringify({v:1,tabs:[{id:'bad',kind:'annotate',docType:'invalid'}]}));expect(loadRecentWorkspaces()).toEqual([]);
  vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('Quota exceeded');});
  expect(()=>rememberRecentWorkspace(pdf())).not.toThrow();
});
