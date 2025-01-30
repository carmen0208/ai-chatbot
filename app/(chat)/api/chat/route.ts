import {
  type DataStreamWriter,
  type Message,
  type StreamTextResult,
  createDataStreamResponse,
  smoothStream,
  streamText,
} from 'ai';
import { z } from 'zod';

import { auth } from '@/app/(auth)/auth';
import { customModel } from '@/lib/ai';
import { models } from '@/lib/ai/models';
import { systemPrompt } from '@/lib/ai/prompts';
import {
  deleteChatById,
  getChatById,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import {
  generateUUID,
  getMostRecentUserMessage,
  sanitizeResponseMessages,
} from '@/lib/utils';

import { generateTitleFromUserMessage } from '../../actions';

export const maxDuration = 60;

type AllowedTools =
  | 'getWalletAddress'
  | 'createEvmWallet'

const tradingTools: AllowedTools[] = [
  'getWalletAddress',
  'createEvmWallet'
];

// const weatherTools: AllowedTools[] = ['getWeather'];

const allTools: AllowedTools[] = [...tradingTools, ];

export async function POST(request: Request): Promise<Response> {
  const {
    id,
    messages,
    modelId,
  }: { id: string; messages: Array<Message>; modelId: string } =
    await request.json();

  const session = await auth();

  if (!session || !session.user || !session.user.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const model = models.find((model) => model.id === modelId);

  if (!model) {
    return new Response('Model not found', { status: 404 });
  }

  const userMessage = getMostRecentUserMessage(messages);

  if (!userMessage) {
    return new Response('No user message found', { status: 400 });
  }

  const chat = await getChatById({ id });

  if (!chat) {
    const title = await generateTitleFromUserMessage({ message: userMessage });
    await saveChat({ id, userId: session.user.id, title });
  }

  await saveMessages({
    messages: [{ ...userMessage, createdAt: new Date(), chatId: id }],
  });
  const userMessageId = generateUUID();

  return createDataStreamResponse({
    execute: (dataStream: DataStreamWriter) => {
      dataStream.writeData({
        type: 'user-message-id',
        content: userMessageId,
      });

      const result: StreamTextResult<any> = streamText({
        model: customModel(model.apiIdentifier),
        system: systemPrompt,
        messages,
        maxSteps: 5,
        experimental_activeTools: allTools,
        tools: {
          getWalletAddress: {
            description: 'Get the current wallet for the trader',
            parameters: z.object({
            }),
            execute: async () => {
              return Promise.resolve({
                content: 'No wallet address found, you should create a wallet first.',
              });
            },
          },
          createEvmWallet: {
            description:
              'Create a EVM wallet for trading',
            parameters: z.object({}),
            execute: async () => {
              return Promise.resolve({
                content: 'Yes, I created an EVM wallet for you, it is 0x1234567890',
              });
            },
          }
        },
        onFinish: async ({ response }) => {
          if (session.user?.id) {
            try {
              const responseMessagesWithoutIncompleteToolCalls =
                sanitizeResponseMessages(response.messages);

              await saveMessages({
                messages: responseMessagesWithoutIncompleteToolCalls.map(
                  (message) => {
                    return {
                      id: message.id,
                      chatId: id,
                      role: message.role,
                      content: message.content,
                      createdAt: new Date(),
                    };
                  },
                ),
              });
            } catch (error) {
              console.error('Failed to save chat');
            }
          }
        },
        experimental_telemetry: {
          isEnabled: true,
          functionId: 'stream-text',
        },
      });
      console.log("carmen:chat:api:chat:finish", {userMessageId, result, dataStream})
      result.mergeIntoDataStream(dataStream);
    },
  });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  const session = await auth();

  if (!session || !session.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const chat = await getChatById({ id });

    if (chat.userId !== session.user.id) {
      return new Response('Unauthorized', { status: 401 });
    }

    await deleteChatById({ id });

    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request', {
      status: 500,
    });
  }
}
