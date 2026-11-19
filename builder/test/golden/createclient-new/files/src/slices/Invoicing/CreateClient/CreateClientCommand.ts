import type {Command} from '@event-driven-io/emmett';
import {CommandHandler} from '@event-driven-io/emmett';
import type {InvoicingEvents} from '../InvoicingEvents';
import {findEventstore} from '../../../common/loadPostgresEventstore';

export type CreateClientCommand = Command<'CreateClient', {
    clientId: string;
    name: string;
    contactEmail: string;
}, {
    correlation_id?: string;
    causation_id?: string;
}>;

export type CreateClientState = {};

export const CreateClientInitialState = (): CreateClientState => ({});

export const evolve = (
    state: CreateClientState,
    event: InvoicingEvents,
): CreateClientState => {
    switch (event.type) {
        default:
            return state;
    }
};

export const decide = (
    command: CreateClientCommand,
    state: CreateClientState,
): InvoicingEvents[] => {
    // BUILD: decide. "Empty name is rejected": throw {code: 'empty_name_is_rejected', message: 'Client name is required'} when the command breaks this rule.
    // BUILD: decide. "Invalid contact email is rejected": throw {code: 'invalid_contact_email_is_rejected', message: 'Contact email must be a valid email address'} when the command breaks this rule.
    return [
        {
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
        },
    ];
};

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
