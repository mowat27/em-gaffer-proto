import type {Command} from '@event-driven-io/emmett';
import {CommandHandler} from '@event-driven-io/emmett';
import {type InvoicingEvents} from '../InvoicingEvents';
import {findEventstore} from '../../../common/loadPostgresEventstore';

// 1. Command type — data fields from slice.json commands[]
export type CreateClientCommand = Command<'CreateClient', {
    clientId: string;
    name: string;
    contactEmail: string;
}, {
    correlation_id?: string;
    causation_id?: string;
}>;

// 2. State — no create-once guard by board decision: a second CreateClient on
//    the same clientId appends another ClientCreated (no spec covers duplicates).
export type CreateClientState = {};

export const CreateClientInitialState = (): CreateClientState => ({});

// 3. Evolve — pure function, updates state from past events
export const evolve = (
    state: CreateClientState,
    event: InvoicingEvents,
): CreateClientState => {
    const {type} = event;

    switch (type) {
        case 'ClientCreated':
            return state;
        default:
            return state;
    }
};

// Pragmatic email validity check (local@domain.tld) per board decision.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 4. Decide — validates command, returns events or throws
export const decide = (
    command: CreateClientCommand,
    state: CreateClientState,
): InvoicingEvents[] => {
    // Board decision: name is rejected when blank after trimming.
    if (!command.data.name || command.data.name.trim() === '') {
        throw {code: 'empty_name', message: 'Client name is required'};
    }

    if (!command.data.contactEmail || !EMAIL_PATTERN.test(command.data.contactEmail)) {
        throw {code: 'invalid_contact_email', message: 'Contact email must be a valid email address'};
    }

    return [{
        type: 'ClientCreated',
        data: {
            clientId: command.data.clientId,
            name: command.data.name,
            contactEmail: command.data.contactEmail,
        },
        metadata: {
            correlation_id: command.metadata?.correlation_id,
            causation_id: command.metadata?.causation_id,
        },
    }];
};

// 5. CommandHandler + exported handle function
const CreateClientCommandHandler = CommandHandler<CreateClientState, InvoicingEvents>({
    evolve,
    initialState: CreateClientInitialState,
});

export const handleCreateClient = async (id: string, command: CreateClientCommand) => {
    const eventStore = await findEventstore();
    const result = await CreateClientCommandHandler(
        eventStore,
        id,
        (state: CreateClientState) => decide(command, state),
    );
    return {
        nextExpectedStreamVersion: result.nextExpectedStreamVersion,
        lastEventGlobalPosition: result.lastEventGlobalPosition,
    };
};
