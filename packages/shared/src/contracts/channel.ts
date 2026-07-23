import { z } from 'zod';
import { AppErrorSchema } from '../schemas/error.js';
import type { ChannelMessage } from '../schemas/protocol.js';
import {
  ChannelSubscriptionSchema,
  type ChannelSubscription,
} from '../schemas/service.js';

const TimestampSchema = z.string().datetime();

export const ChannelConnectionStatusSchema = z.enum([
  'connecting',
  'connected',
  'degraded',
  'disconnected',
]);

export type ChannelConnectionStatus = z.infer<
  typeof ChannelConnectionStatusSchema
>;

export const ChannelHealthSchema = z.object({
  status: ChannelConnectionStatusSchema,
  connectedAt: TimestampSchema.nullable(),
  lastMessageAt: TimestampSchema.nullable(),
  lastSuccessAt: TimestampSchema.nullable(),
  lastError: AppErrorSchema.nullable(),
});

export type ChannelHealth = z.infer<typeof ChannelHealthSchema>;

export type ChannelMessageHandler = (
  message: ChannelMessage,
) => void | Promise<void>;

export interface ChannelConnection {
  readonly subscriptionId: string;
  health(): ChannelHealth;
  close(): Promise<void>;
}

export const ReplyPayloadSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  threadKey: z.string().min(1).optional(),
  replyToEventId: z.string().min(1).optional(),
});

export type ReplyPayload = z.infer<typeof ReplyPayloadSchema>;

export const SendReplyResultSchema = z.object({
  providerMessageId: z.string().min(1),
  acceptedAt: TimestampSchema,
  deduplicated: z.boolean(),
});

export type SendReplyResult = z.infer<typeof SendReplyResultSchema>;

export interface ChannelTransport {
  readonly name: string;

  connect(
    subscription: ChannelSubscription,
    onMessage: ChannelMessageHandler,
    signal: AbortSignal,
  ): Promise<ChannelConnection>;

  sendReply(
    subscription: ChannelSubscription,
    payload: ReplyPayload,
    dedupeKey: string,
    signal: AbortSignal,
  ): Promise<SendReplyResult>;

  health(): Promise<ChannelHealth>;
  close(): Promise<void>;
}

export const ChannelTransportFactoryContextSchema = z.object({
  subscription: ChannelSubscriptionSchema,
  credential: z.string().min(1).nullable(),
});

export type ChannelTransportFactoryContext = z.infer<
  typeof ChannelTransportFactoryContextSchema
>;

export type ChannelTransportFactory = (
  context: ChannelTransportFactoryContext,
) => ChannelTransport;
