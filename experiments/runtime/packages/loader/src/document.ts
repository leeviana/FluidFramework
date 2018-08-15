import { ICommit } from "@prague/gitresources";
import {
    IClient,
    IDocumentAttributes,
    IDocumentService,
    IDocumentStorageService,
    ISequencedDocumentMessage,
    ISnapshotTree,
    ITokenService,
    IUser,
    MessageType,
} from "@prague/runtime-definitions";
import { EventEmitter } from "events";
import now = require("performance-now");
import { debug } from "./debug";
import { IConnectionDetails } from "./deltaConnection";
import { DeltaManager } from "./deltaManager";
import { IDeltaManager } from "./deltas";

interface IConnectResult {
    detailsP: Promise<IConnectionDetails>;

    handlerAttachedP: Promise<void>;
}

/**
 * Document details extracted from the header
 */
interface IHeaderDetails {
    // Attributes for the document
    attributes: IDocumentAttributes;

    // Tree representing all blobs in the snapshot
    tree: ISnapshotTree;
}

function getEmptyHeader(id: string): IHeaderDetails {
    const emptyHeader: IHeaderDetails = {
        attributes: {
            branch: id,
            clients: [],
            minimumSequenceNumber: 0,
            sequenceNumber: 0,
        },
        tree: null,
    };

    return emptyHeader;
}

async function readAndParse<T>(storage: IDocumentStorageService, sha: string): Promise<T> {
    const encoded = await storage.read(sha);
    const decoded = Buffer.from(encoded, "base64").toString();
    return JSON.parse(decoded);
}

// NOTE this may want to move to the protocol
export enum ConnectionState {
    /**
     * The document is no longer connected to the delta server
     */
    Disconnected,

    /**
     * The document has an inbound connection but is still pending for outbound deltas
     */
    Connecting,

    /**
     * The document is fully connected
     */
    Connected,
}

export class Document extends EventEmitter {
    private pendingClientId: string;
    private loaded = false;
    private clients = new Map<string, IClient>();
    private connectionState = ConnectionState.Disconnected;

    // tslint:disable:variable-name
    private _deltaManager: DeltaManager;
    private _existing: boolean;
    private _id: string;
    private _parentBranch: string;
    private _tenantId: string;
    private _user: IUser;
    // tslint:enable:variable-name

    public get tenantId(): string {
        return this._tenantId;
    }

    public get id(): string {
        return this._id;
    }

    public get deltaManager(): IDeltaManager {
        return this._deltaManager;
    }

    public get user(): IUser {
        return this._user;
    }

    /**
     * Flag indicating whether the document already existed at the time of load
     */
    public get existing(): boolean {
        return this._existing;
    }

    /**
     * Returns the parent branch for this document
     */
    public get parentBranch(): string {
        return this._parentBranch;
    }

    constructor(
        private token: string,
        private service: IDocumentService,
        tokenService: ITokenService,
        private options: any) {
        super();

        const claims = tokenService.extractClaims(token);
        this._id = claims.documentId;
        this._tenantId = claims.tenantId;
        this._user = claims.user;
    }

    public async load(specifiedVersion: ICommit, connect: boolean): Promise<void> {
        const storageP = this.service.connectToStorage(this.tenantId, this.id, this.token);

        // If a version is specified we will load it directly - otherwise will query historian for the latest
        // version and then load it
        const versionP = specifiedVersion
            ? Promise.resolve(specifiedVersion)
            : storageP.then(async (storage) => {
                const versions = await storage.getVersions(this.id, 1);
                return versions.length > 0 ? versions[1] : null;
            });

        // Kick off async operations to load the document state
        // ... get the header which provides access to the 'first page' of the document
        const headerP = Promise.all([storageP, versionP])
            .then(([storage, version]) => {
                return this.getHeader(this.id, storage, version);
            });

        // TODO the below I can't do until I actually have the code loaded
        // ... load the distributed data structures from the snapshot
        // const dataStructuresLoadedP = Promise.all([storageP, headerP]).then(async ([storage, header]) => {
        //     await this.loadSnapshot(storage, header);
        // });

        // ... begin the connection process to the delta stream
        const connectResult: IConnectResult = connect
            ? this.connect(headerP)
            : { detailsP: Promise.resolve(null), handlerAttachedP: Promise.resolve() };

        // Wait for all the loading promises to finish
        return Promise
            .all([storageP, versionP, headerP, connectResult.handlerAttachedP])
            .then(async ([storageService, version, header]) => {
                this.clients = new Map(header.attributes.clients);

                // Start delta processing once all objects are loaded
                // const readyP = Array.from(this.distributedObjects.values()).map((value) => value.object.ready());
                // Promise.all(readyP).then(
                //     () => {
                //         if (connect) {
                //             assert(this._deltaManager, "DeltaManager should have been created during connect call");
                //             debug("Everyone ready - resuming inbound messages");
                //             this._deltaManager.inbound.resume();
                //             this._deltaManager.outbound.resume();
                //         }
                //     },
                //     (error) => {
                //         this.emit("error", error);
                //     });
                if (connect) {
                    this._deltaManager.inbound.resume();
                    this._deltaManager.outbound.resume();
                }

                // Initialize document details - if loading a snapshot use that - otherwise we need to wait on
                // the initial details
                if (version) {
                    this._existing = true;
                    this._parentBranch = header.attributes.branch !== this.id ? header.attributes.branch : null;
                } else {
                    const details = await connectResult.detailsP;
                    this._existing = details.existing;
                    this._parentBranch = details.parentBranch;
                }

                // Internal context is fully loaded at this point
                this.loaded = true;

                // Now that we are loaded notify all distributed data types of connection change
                // this.notifyConnectionState(this.connectionState);

                // Waiting on the root is also good
                // If it's a new document we create the root map object - otherwise we wait for it to become available
                // This I don't think I can get rid of
                // if (!this.existing) {
                //     this.createAttached(rootMapId, mapExtension.MapExtension.Type);
                //     this.createInsightsMap();
                // } else {
                //     await this.get(rootMapId);
                // }

                debug(`Document loaded ${this.id}: ${now()} `);
            });
    }

    private async getHeader(
        id: string,
        storage: IDocumentStorageService,
        version: ICommit): Promise<IHeaderDetails> {

        if (!version) {
            return getEmptyHeader(id);
        }

        const tree = await storage.getSnapshotTree(version);
        const attributes = await readAndParse<IDocumentAttributes>(storage, tree.blobs[".attributes"]);

        return { attributes, tree };
    }

    private connect(headerP: Promise<IHeaderDetails>): IConnectResult {
        // Create the DeltaManager and begin listening for connection events
        const clientDetails = this.options ? this.options.client : null;
        this._deltaManager = new DeltaManager(this.id, this.tenantId, this.service, clientDetails, true);

        // Open a connection - the DeltaMananger will automatically reconnect
        const detailsP = this._deltaManager.connect("Document loading", this.token);
        this._deltaManager.on("connect", (details: IConnectionDetails) => {
            this.setConnectionState(ConnectionState.Connecting, "websocket established", details.clientId);
        });

        this._deltaManager.on("disconnect", (nack: boolean) => {
            this.setConnectionState(ConnectionState.Disconnected, `nack === ${nack}`);
            this.emit("disconnect");
        });

        this._deltaManager.on("error", (error) => {
            this.emit("error", error);
        });

        this._deltaManager.on("pong", (latency) => {
            this.emit("pong", latency);
        });

        this._deltaManager.on("processTime", (time) => {
            this.emit("processTime", time);
        });

        // Begin fetching any pending deltas once we know the base sequence #. Can this fail?
        // It seems like something, like reconnection, that we would want to retry but otherwise allow
        // the document to load
        const handlerAttachedP = headerP.then((header) => {
            this._deltaManager.attachOpHandler(
                header.attributes.sequenceNumber,
                {
                    prepare: async (message) => {
                        return this.prepareRemoteMessage(message);
                    },
                    process: (message, context) => {
                        this.processRemoteMessage(message, context);
                    },
                });
            });

        return { detailsP, handlerAttachedP };
    }

    private setConnectionState(value: ConnectionState.Disconnected, reason: string);
    private setConnectionState(value: ConnectionState.Connecting | ConnectionState.Connected,
                               reason: string,
                               clientId: string);
    private setConnectionState(value: ConnectionState, reason: string, context?: string) {
        if (this.connectionState === value) {
            // Already in the desired state - exit early
            return;
        }

        debug(`Changing from ${ConnectionState[this.connectionState]} to ${ConnectionState[value]}: ${reason}`);
        this.connectionState = value;

        // Stash the clientID to detect when transitioning from connecting (socket.io channel open) to connected
        // (have received the join message for the client ID)
        if (value === ConnectionState.Connecting) {
            this.pendingClientId = context;
        }

        if (!this.loaded) {
            // If not fully loaded return early
            return;
        }

        if (this.connectionState === ConnectionState.Connected) {
            this.emit("connected");
        }
    }

    private async prepareRemoteMessage(message: ISequencedDocumentMessage): Promise<any> {
        return;
    }

    private processRemoteMessage(message: ISequencedDocumentMessage, context: any) {
        switch (message.type) {
            case MessageType.ClientJoin:
                this.clients.set(message.contents.clientId, message.contents.detail);

                // This is the only one that requires the pending client ID
                if (message.contents.clientId === this.pendingClientId) {
                    this.setConnectionState(
                        ConnectionState.Connected,
                        `joined @ ${message.minimumSequenceNumber}`,
                        this.pendingClientId);
                }

                this.emit("clientJoin", message.contents);
                break;

            case MessageType.ClientLeave:
                this.clients.delete(message.contents);
                this.emit("clientLeave", message.contents);
                break;

            default:
                break;
        }

        this.emit("op", message);
    }
}
