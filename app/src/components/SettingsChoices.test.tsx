/** @vitest-environment jsdom */
import {act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {SettingsChoices} from './SettingsChoices';

it('allows keyboard selection when a setting has no initial answer',()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  function Question(){
    const [answer,setAnswer]=useState<boolean|null>(null);
    return <SettingsChoices role="radiogroup" aria-label="Accepts images">
      <button role="radio" aria-checked={answer===false} onClick={()=>setAnswer(false)}><strong>No</strong></button>
      <button role="radio" aria-checked={answer===true} onClick={()=>setAnswer(true)}><strong>Yes</strong></button>
    </SettingsChoices>;
  }
  try{
    act(()=>root.render(<Question/>));
    const [no,yes]=[...host.querySelectorAll('button')];
    expect(no.tabIndex).toBe(0);expect(yes.tabIndex).toBe(-1);
    act(()=>{no.focus();no.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));});
    expect(document.activeElement).toBe(yes);expect(yes.getAttribute('aria-checked')).toBe('true');
    expect(yes.tabIndex).toBe(0);expect(no.tabIndex).toBe(-1);
  }finally{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
