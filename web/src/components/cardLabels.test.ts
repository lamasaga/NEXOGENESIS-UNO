import { expect, it } from 'vitest';
import { cardTypeLabel } from './cardReading';

it('reading surfaces display the current primary type and keep unknown values explicit', () => {
  expect(cardTypeLabel({type:'mechanism'})).toBe('机制');
  expect(cardTypeLabel({type:'conflict'})).toBe('争议');
  expect(cardTypeLabel({type:'undetermined'})).toBe('未定');
  expect(cardTypeLabel({type:'custom-legacy'})).toBe('custom-legacy');
  expect(cardTypeLabel({})).toBe('未分类');
});
