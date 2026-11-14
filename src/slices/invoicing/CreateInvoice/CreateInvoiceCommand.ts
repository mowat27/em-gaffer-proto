import type {Command} from '@event-driven-io/emmett';
import {CommandHandler} from '@event-driven-io/emmett';
import {type InvoicingEvents} from '../InvoicingEvents';
import {findEventstore} from '../../../common/loadPostgresEventstore';

// 1. Command type — data fields from slice.json commands[]
export type CreateInvoiceCommand = Command<'CreateInvoice', {
    invoiceId: string;
    clientId: string;
    amount: number;
    date: string;
}, {
    correlation_id?: string;
    causation_id?: string;
}>;

// 2. State — tracks clients known from ClientCreated events so that
//    "Unknown client is rejected" can be validated in decide.
export type CreateInvoiceState = {
    knownClientIds: Set<string>;
};

export const CreateInvoiceInitialState = (): CreateInvoiceState => ({
    knownClientIds: new Set<string>(),
});

// 3. Evolve — pure function, updates state from past events
export const evolve = (
    state: CreateInvoiceState,
    event: InvoicingEvents,
): CreateInvoiceState => {
    const {type} = event;

    switch (type) {
        case 'ClientCreated':
            return {
                ...state,
                knownClientIds: new Set(state.knownClientIds).add(event.data.clientId),
            };
        default:
            return state;
    }
};

// 4. Decide — validates command, returns events or throws
export const decide = (
    command: CreateInvoiceCommand,
    state: CreateInvoiceState,
): InvoicingEvents[] => {
    // spec: "Unknown client is rejected" — "Client does not exist"
    if (!state.knownClientIds.has(command.data.clientId)) {
        throw {code: 'unknown_client', message: 'Client does not exist'};
    }

    // spec: "Zero amount is rejected" — "Amount must be greater than zero"
    if (!(command.data.amount > 0)) {
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

// 5. CommandHandler + exported handle function
const CreateInvoiceCommandHandler = CommandHandler<CreateInvoiceState, InvoicingEvents>({
    evolve,
    initialState: CreateInvoiceInitialState,
});

export const handleCreateInvoice = async (id: string, command: CreateInvoiceCommand) => {
    const eventStore = await findEventstore();
    const result = await CreateInvoiceCommandHandler(
        eventStore,
        id,
        (state: CreateInvoiceState) => decide(command, state),
    );
    return {
        nextExpectedStreamVersion: result.nextExpectedStreamVersion,
        lastEventGlobalPosition: result.lastEventGlobalPosition,
    };
};
