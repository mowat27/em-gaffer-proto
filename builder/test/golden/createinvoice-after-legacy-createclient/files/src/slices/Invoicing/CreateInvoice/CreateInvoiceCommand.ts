import type {Command} from '@event-driven-io/emmett';
import {CommandHandler} from '@event-driven-io/emmett';
import type {InvoicingEvents} from '../InvoicingEvents';
import {findEventstore} from '../../../common/loadPostgresEventstore';

export type CreateInvoiceCommand = Command<'CreateInvoice', {
    invoiceId: string;
    clientId: string;
    amount: number;
    date: string;
}, {
    correlation_id?: string;
    causation_id?: string;
}>;

// BUILD: state. Hold what decide needs from earlier events (ClientCreated); keep {} if it needs nothing.
export type CreateInvoiceState = {};

export const CreateInvoiceInitialState = (): CreateInvoiceState => ({});

export const evolve = (
    state: CreateInvoiceState,
    event: InvoicingEvents,
): CreateInvoiceState => {
    // BUILD: evolve. Fold ClientCreated into the state for decide; return the state unchanged for every other event.
    switch (event.type) {
        default:
            return state;
    }
};

export const decide = (
    command: CreateInvoiceCommand,
    state: CreateInvoiceState,
): InvoicingEvents[] => {
    // BUILD: decide. "Unknown client is rejected": throw {code: 'unknown_client_is_rejected', message: 'Client does not exist'} when the command breaks this rule.
    // BUILD: decide. "Zero amount is rejected": throw {code: 'zero_amount_is_rejected', message: 'Amount must be greater than zero'} when the command breaks this rule.
    return [
        {
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
        },
    ];
};

const CreateInvoiceCommandHandler = CommandHandler<CreateInvoiceState, InvoicingEvents>({
    evolve,
    initialState: CreateInvoiceInitialState,
});

export const handleCreateInvoice = async (id: string, command: CreateInvoiceCommand) => {
    const eventStore = await findEventstore();
    // BUILD: handle. ClientCreated comes from another slice. If it is on another stream than this command's, load that fact (for example from its read model with getKnexInstance() from src/common/db) and add it to the state before decide.
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
