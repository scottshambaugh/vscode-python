// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { Disposable, Event, EventEmitter } from 'vscode';
import {
    ExecutionFactoryCreateWithEnvironmentOptions,
    IPythonExecutionFactory,
    SpawnOptions,
} from '../../../common/process/types';
import { traceLog } from '../../../logging';
import { DataReceivedEvent, ITestServer, TestCommandOptions } from './types';
import { DEFAULT_TEST_PORT } from './utils';

export class PythonTestServer implements ITestServer, Disposable {
    private _onDataReceived: EventEmitter<DataReceivedEvent> = new EventEmitter<DataReceivedEvent>();

    private uuids: Map<string, string>;

    private server: http.Server;

    public port: number;

    constructor(private executionFactory: IPythonExecutionFactory) {
        this.uuids = new Map();

        this.port = DEFAULT_TEST_PORT;

        const requestListener: http.RequestListener = async (request, response) => {
            const buffers = [];

            try {
                for await (const chunk of request) {
                    buffers.push(chunk);
                }

                const data = Buffer.concat(buffers).toString();

                response.end();

                const { uuid } = JSON.parse(data);

                // Check if the uuid we received exists in the list of active ones.
                // If yes, process the response, if not, ignore it.
                const cwd = this.uuids.get(uuid);
                if (cwd) {
                    this._onDataReceived.fire({ cwd, data });
                    this.uuids.delete(uuid);
                }
            } catch (ex) {
                traceLog(`Error processing test server request: ${ex}`);
                this._onDataReceived.fire({ cwd: '', data: '' });
            }
        };

        this.server = http.createServer(requestListener);
        this.server.listen(() => {
            this.port = (this.server.address() as net.AddressInfo).port;
        });
    }

    public dispose(): void {
        this.server.close();
        this._onDataReceived.dispose();
    }

    public get onDataReceived(): Event<DataReceivedEvent> {
        return this._onDataReceived.event;
    }

    async sendCommand(options: TestCommandOptions): Promise<void> {
        const uuid = crypto.randomUUID();
        const spawnOptions: SpawnOptions = {
            token: options.token,
            cwd: options.cwd,
            throwOnStdErr: true,
        };

        this.uuids.set(uuid, options.cwd);

        // Create the Python environment in which to execute the command.
        const creationOptions: ExecutionFactoryCreateWithEnvironmentOptions = {
            allowEnvironmentFetchExceptions: false,
            resource: options.workspaceFolder,
        };
        const execService = await this.executionFactory.createActivatedEnvironment(creationOptions);

        // Add the generated UUID to the data to be sent (expecting to receive it back).
        const args = [options.command.script, '--port', this.port.toString(), '--uuid', uuid].concat(
            options.command.args,
        );

        if (options.outChannel) {
            options.outChannel.appendLine(`python ${args.join(' ')}`);
        }

        try {
            await execService.exec(args, spawnOptions);
        } catch (ex) {
            this.uuids.delete(uuid);
            this._onDataReceived.fire({
                cwd: options.cwd,
                data: JSON.stringify({
                    status: 'error',
                    errors: [(ex as Error).message],
                }),
            });
        }
    }
}
