import {expect,it} from 'vitest';
import {countSettingsChanges} from './settingsChanges';
it('counts controls inside nested settings and ignores property order',()=>{
  const saved={hand:'right',thinking:{steps:false,auto:false},model:'local'};
  expect(countSettingsChanges({...saved,thinking:{auto:false,steps:false}},saved)).toBe(0);
  const draft={...saved,hand:'left',thinking:{steps:true,auto:true}};
  expect(countSettingsChanges(draft,saved)).toBe(3);
  expect(countSettingsChanges({...draft,hand:'right'},saved)).toBe(2);
  expect(countSettingsChanges(saved,saved)).toBe(0);
});
it('counts optional and collection settings as controls',()=>{
  expect(countSettingsChanges({a:1},{a:1,b:true})).toBe(1);
  expect(countSettingsChanges({a:1,b:true},{a:1})).toBe(1);
  expect(countSettingsChanges({presets:['a','b']},{presets:['a']})).toBe(1);
  expect(countSettingsChanges({presets:['a','b']},{presets:['a','b']})).toBe(0);
});
