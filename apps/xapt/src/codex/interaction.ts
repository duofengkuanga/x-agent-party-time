import {
  sanitizeExecutionInteractionPayload,
  type JsonValue,
} from '@agent-party-time/execution-contract';
import { asRecord } from './wire-values';

export function isInteractionMethod(method: string): boolean {
  return [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
  ].includes(method);
}

export function defaultDecline(method: string): JsonValue {
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'item/permissions/requestApproval')
    return { permissions: {}, scope: 'turn' };
  return { decision: 'decline' };
}

export function publicInteractionPayload(
  method: string,
  value: unknown,
): JsonValue {
  return sanitizeExecutionInteractionPayload(method, value);
}

export function restorePrivateInteractionResolution(
  method: string,
  resolution: JsonValue,
  privatePayload: unknown,
): JsonValue {
  if (method !== 'item/permissions/requestApproval') return resolution;
  const response = asRecord(resolution);
  if (
    !['turn', 'session'].includes(String(response.scope)) ||
    Object.keys(asRecord(response.permissions)).length === 0
  )
    return resolution;
  const privatePermissions = asRecord(privatePayload).permissions;
  const publicPermissions = asRecord(
    publicInteractionPayload(method, privatePayload),
  ).permissions;
  return {
    ...response,
    permissions: restoreSelectedJson(
      response.permissions,
      publicPermissions,
      privatePermissions,
    ),
  };
}

function restoreSelectedJson(
  selected: unknown,
  publicValue: unknown,
  privateValue: unknown,
): JsonValue {
  if (Array.isArray(selected)) {
    if (!Array.isArray(publicValue) || !Array.isArray(privateValue))
      throw new Error('权限恢复结构与原始请求不一致');
    return selected.map((selectedItem) => {
      const index = publicValue.findIndex((candidate) =>
        isJsonSubset(selectedItem, candidate),
      );
      if (index < 0) throw new Error('权限子集不属于原始请求');
      return restoreSelectedJson(
        selectedItem,
        publicValue[index],
        privateValue[index],
      );
    });
  }
  if (selected && typeof selected === 'object') {
    const publicRecord = asRecord(publicValue);
    const privateRecord = asRecord(privateValue);
    return Object.fromEntries(
      Object.entries(selected).map(([key, child]) => {
        if (!(key in publicRecord) || !(key in privateRecord))
          throw new Error('权限子集不属于原始请求');
        return [
          key,
          restoreSelectedJson(child, publicRecord[key], privateRecord[key]),
        ];
      }),
    );
  }
  if (!jsonEquals(selected, publicValue))
    throw new Error('权限子集不属于原始请求');
  return sanitizeJsonValue(privateValue);
}

function isJsonSubset(candidate: unknown, requested: unknown): boolean {
  if (
    candidate === null ||
    typeof candidate === 'string' ||
    typeof candidate === 'number' ||
    typeof candidate === 'boolean'
  )
    return candidate === requested;
  if (Array.isArray(candidate))
    return (
      Array.isArray(requested) &&
      candidate.every((value) =>
        requested.some((requestedValue) => isJsonSubset(value, requestedValue)),
      )
    );
  if (candidate && typeof candidate === 'object') {
    if (!requested || typeof requested !== 'object' || Array.isArray(requested))
      return false;
    const requestedRecord = requested as Record<string, unknown>;
    return Object.entries(candidate).every(
      ([key, value]) =>
        key in requestedRecord && isJsonSubset(value, requestedRecord[key]),
    );
  }
  return false;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  )
    return left === right;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  return (
    leftEntries.length === Object.keys(rightRecord).length &&
    leftEntries.every(
      ([key, value]) =>
        key in rightRecord && jsonEquals(value, rightRecord[key]),
    )
  );
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sanitizeJsonValue(child),
      ]),
    );
  return null;
}
