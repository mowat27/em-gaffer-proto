import type {Command} from '@event-driven-io/emmett';
import {CommandHandler} from '@event-driven-io/emmett';
import type {InvoicingEvents} from '../InvoicingEvents';
import {findEventstore} from '../../../common/loadPostgresEventstore';

// [decision] Email validity is a pragmatic local@domain.tld regex check; name is rejected when blank after trimming.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 1. Command type — data fields come from slice.json commands[]
export type CreateClientCommand = Command<'CreateClient', {
    clientId: string;
    name: string;
    contactEmail: string;
}, {
    correlation_id?: string;
    causation_id?: string;
}>;

// 2. State — [decision] CreateClient has no create-once guard: no spec covers a repeated CreateClient on the same clientId, so a second POST appends another ClientCreated.
export type CreateClientState = {};

export const CreateClientInitialState = (): CreateClientState => ({});

// 3. Evolve — pure function, updates state from past events
export const evolve = (
    state: CreateClientState,
    _event: InvoicingEvents,
): CreateClientState => {
    return state;
};

// 4. Decide — validates command, returns events or throws
export const decide = (
    command: CreateClientCommand,
    _state: CreateClientState,
): InvoicingEvents[] => {
    if (!command.data.name || command.data.name.trim().length === 0) {
        throw {code: 'client_name_required', message: 'Client name is required'};
    }

    if (!command.data.contactEmail || !EMAIL_REGEX.test(command.data.contactEmail.trim())) {
        throw {code: 'invalid_contact_email', message: 'Contact email must be a valid email address'};
    }

    return [{
        type: 'ClientCreated',
        data: {
            clientId: command.data.clientId,
            name: command.data.name.trim(),
            contactEmail: command.data.contactEmail.trim(),
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
