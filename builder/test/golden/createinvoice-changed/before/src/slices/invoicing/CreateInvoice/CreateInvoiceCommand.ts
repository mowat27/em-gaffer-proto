import type {Command} from '@event-driven-io/emmett';
import {CommandHandler} from '@event-driven-io/emmett';
import {type InvoicingEvents} from '../InvoicingEvents';
import {findEventstore} from '../../../common/loadPostgresEventstore';
import {getKnexInstance} from '../../../common/db';

export type CreateInvoiceCommand = Command<'CreateInvoice', {
    invoiceId: string;
    clientId: string;
    amount: number;
    date: string;
}, {
    correlation_id?: string;
    causation_id?: string;
}>;

export type CreateInvoiceState = {
    created: boolean;
    knownClientIds: Set<string>;
};

export const CreateInvoiceInitialState = (): CreateInvoiceState => ({
    created: false,
    knownClientIds: new Set<string>(),
});

export const evolve = (
    state: CreateInvoiceState,
    event: InvoicingEvents,
): CreateInvoiceState => {
    switch (event.type) {
        case 'ClientCreated': {
            const knownClientIds = new Set(state.knownClientIds);
            if (event.data?.clientId) {
                knownClientIds.add(event.data.clientId);
            }
            return {
                ...state,
                knownClientIds,
            };
        }
        case 'InvoiceCreated':
            return {
                ...state,
                created: true,
            };
        default:
            return state;
    }
};

export const decide = (
    command: CreateInvoiceCommand,
    state: CreateInvoiceState,
): InvoicingEvents[] => {
    if (state.created) {
        throw {code: 'already_created', message: 'Invoice already exists'};
    }

    if (!state.knownClientIds.has(command.data.clientId)) {
        throw {code: 'client_does_not_exist', message: 'Client does not exist'};
    }

    if (command.data.amount <= 0) {
        throw {code: 'zero_amount', message: 'Amount must be greater than zero'};
    }

    return [{
        type: 'InvoiceCreated',
        data: {
            invoiceId: command.data.invoiceId,
            clientId: command.data.clientId,
            amount: command.data.amount,
            date: command.data.date,
        },
        metadata: {
            correlation_id: command.metadata?.correlation_id,
            causation_id: command.metadata?.causation_id,
        },
    }];
};

const CreateInvoiceCommandHandler = CommandHandler<CreateInvoiceState, InvoicingEvents>({
    evolve,
    initialState: CreateInvoiceInitialState,
});

export const handleCreateInvoice = async (invoiceId: string, command: CreateInvoiceCommand) => {
    const eventStore = await findEventstore();

    let clientFound = false;
    try {
        const knex = getKnexInstance();
        const tables = await knex.raw(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('clients', 'invoices_client_lookup', 'invoices_client_names')`
        );
        for (const row of tables.rows || []) {
            try {
                const found = await knex(row.table_name)
                    .where('client_id', command.data.clientId)
                    .orWhere('id', command.data.clientId)
                    .first();
                if (found) {
                    clientFound = true;
                    break;
                }
            } catch {
                // column might not exist
            }
        }
    } catch {
        // DB unreachable or table not present
    }

    if (!clientFound) {
        try {
            const streamCandidates = [
                command.data.clientId,
                `client-${command.data.clientId}`,
                `Client-${command.data.clientId}`,
            ];
            for (const streamId of streamCandidates) {
                const stream = await eventStore.readStream(streamId);
                if (stream && stream.events && stream.events.length > 0) {
                    clientFound = true;
                    break;
                }
            }
        } catch {
            // Stream not found
        }
    }

    const result = await CreateInvoiceCommandHandler(
        eventStore,
        invoiceId,
        (state: CreateInvoiceState) => {
            const effectiveState = clientFound
                ? {
                    ...state,
                    knownClientIds: new Set(state.knownClientIds).add(command.data.clientId),
                }
                : state;
            return decide(command, effectiveState);
        },
    );

    return {
        nextExpectedStreamVersion: result.nextExpectedStreamVersion,
        lastEventGlobalPosition: result.lastEventGlobalPosition,
    };
};
