import { expect, test } from 'bun:test';
import { resizeAdjacentColumns } from './boardColumnResize';

test('拖拽分隔条可向同侧多列借宽度，总宽保持且每列不小于可读下限', () => {
  const widths = [190, 190, 190, 190, 190, 190];
  expect(resizeAdjacentColumns(widths, 1, 24)).toEqual([190, 214, 166, 190, 190, 190]);
  expect(resizeAdjacentColumns(widths, 1, 160)).toEqual([190, 350, 140, 140, 140, 180]);
  expect(resizeAdjacentColumns(widths, 1, -160)).toEqual([140, 140, 290, 190, 190, 190]);
  expect(widths).toEqual([190, 190, 190, 190, 190, 190]);
});
