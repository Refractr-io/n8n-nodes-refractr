import type { INodeProperties } from 'n8n-workflow';

export const accountOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['account'] } },
		options: [
			{
				name: 'Get Credit Balance',
				value: 'getCredits',
				description: 'Get the current credit balance and lifetime purchased and used totals',
				action: 'Get the credit balance',
			},
			{
				name: 'Get Usage',
				value: 'getUsage',
				description: 'Get daily request and credit totals across all of your API keys',
				action: 'Get usage',
			},
		],
		default: 'getCredits',
	},
];

export const accountFields: INodeProperties[] = [
	{
		displayName: 'Days',
		name: 'days',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 30,
		displayOptions: { show: { resource: ['account'], operation: ['getUsage'] } },
		description: 'How many days back to include',
	},
];
