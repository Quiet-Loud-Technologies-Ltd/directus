import { ErrorCode, ServiceUnavailableError } from '@directus/errors';
import type { Bus } from '@directus/memory';
import { useBus } from '../../bus/index.js';
import emitter from '../../emitter.js';
import { getWebSocketController } from '../controllers/index.js';
import type { WebSocketController } from '../controllers/rest.js';
import { WebSocketError, handleWebSocketError } from '../errors.js';
import { WebSocketLogsMessage } from '../messages.js';
import type { LogsSubscription, WebSocketClient } from '../types.js';
import { fmtMessage, getMessageType } from '../utils/message.js';

export class LogsHandler {
	controller: WebSocketController;
	messenger: Bus;
	subscriptions: Set<LogsSubscription>;

	constructor(controller?: WebSocketController) {
		controller = controller ?? getWebSocketController();

		if (!controller) {
			throw new ServiceUnavailableError({ service: 'ws', reason: 'WebSocket server is not initialized' });
		}

		this.controller = controller;
		this.messenger = useBus();
		this.subscriptions = new Set();

		this.bindWebSocket();

		this.messenger.subscribe('logs', (message: Record<string, any>) => {
			this.subscriptions.forEach((subscription) => subscription.client.send(fmtMessage('logs', { data: message })));
		});
	}

	/**
	 * Hook into websocket client lifecycle events
	 */
	bindWebSocket() {
		// listen to incoming messages on the connected websockets
		emitter.onAction('websocket.message', ({ client, message }) => {
			if (!['subscribe_logs', 'unsubscribe_logs'].includes(getMessageType(message))) return;

			try {
				const parsedMessage = WebSocketLogsMessage.parse(message);

				this.onMessage(client, parsedMessage).catch((error) => {
					// this catch is required because the async onMessage function is not awaited
					handleWebSocketError(client, error, 'logs');
				});
			} catch (error) {
				handleWebSocketError(client, error, 'logs');
			}
		});

		// unsubscribe when a connection drops
		emitter.onAction('websocket.error', ({ client }) => this.unsubscribe(client));
		emitter.onAction('websocket.close', ({ client }) => this.unsubscribe(client));
	}

	/**
	 * Register a logs subscription
	 * @param subscription
	 */
	subscribe(subscription: LogsSubscription) {
		this.subscriptions.add(subscription);
	}

	/**
	 * Remove a logs subscription
	 * @param client WebSocketClient
	 */
	unsubscribe(client: WebSocketClient) {
		for (const subscription of this.subscriptions) {
			if (subscription.client === client) {
				this.subscriptions.delete(subscription);
			}
		}
	}

	/**
	 * Handle incoming (un)subscribe requests
	 */
	async onMessage(client: WebSocketClient, message: WebSocketLogsMessage) {
		const accountability = client.accountability;

		if (!accountability?.admin) {
			throw new WebSocketError('logs', ErrorCode.Forbidden, `You don't have permission to access this.`);
		}

		if (message.type === 'subscribe_logs') {
			try {
				this.subscribe({ client });

				client.send(fmtMessage('logs', { event: 'subscribe_logs' }));
			} catch (err) {
				handleWebSocketError(client, err, 'subscribe_logs');
			}
		} else if (message.type === 'unsubscribe_logs') {
			try {
				this.unsubscribe(client);

				client.send(fmtMessage('logs', { event: 'unsubscribe_logs' }));
			} catch (err) {
				handleWebSocketError(client, err, 'unsubscribe_logs');
			}
		}
	}
}