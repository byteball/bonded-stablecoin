const path = require('path')
// eslint-disable-next-line no-unused-vars
const { Testkit, Utils } = require('aa-testkit')
const formulaCommon = require('ocore/formula/common.js');
const { Network } = Testkit({
	TESTDATA_DIR: path.join(__dirname, '../testdata'),
})

function round(n, precision) {
	return Math.round(n * 10 ** precision) / 10 ** precision;
}

describe('Governance proposal', function () {
	this.timeout(120 * 1000)

	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.agent({ bank: path.join(__dirname, '../node_modules/bank-aa/bank.oscript') })
			.with.agent({ bs: path.join(__dirname, '../bonded-stablecoin.oscript') })
			.with.agent({ bsf: path.join(__dirname, '../bonded-stablecoin-factory.oscript') })
			.with.agent({ daf2: path.join(__dirname, '../define-asset2-forwarder.oscript') })
			.with.agent({ governance: path.join(__dirname, '../governance.oscript') })
			.with.agent({ deposits: path.join(__dirname, '../deposits.oscript') })
			.with.wallet({ oracle: 1e9 })
			.with.wallet({ alice: 10000e9 })
			.with.wallet({ bob: 1000e9 })
			.with.wallet({ charlie: 1000e9 })
			.with.explorer()
			.run()
		console.log('--- agents\n', this.network.agent)
	//	console.log('--- wallets\n', this.network.wallet)
		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		this.charlie = this.network.wallet.charlie
		this.charlieAddress = await this.charlie.getAddress()
	//	this.explorer = await this.network.newObyteExplorer().ready()

		const balance = await this.bob.getBalance()
		console.log(balance)
		expect(balance.base.stable).to.be.equal(1000e9)
	})

	it('Post data feed', async () => {
		const price = 20
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: price,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload.GBYTE_USD).to.be.equal(price)
		await this.network.witnessUntilStable(unit)

		this.price = price
	})
	
	it('Bob defines a new stablecoin', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		this.fee_multiplier = 2
		this.interest_rate = 0.1
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.bsf,
			amount: 15000,
			data: {
				reserve_asset: 'base',
				reserve_asset_decimals: 9,
				decimals1: 9,
				decimals2: 2,
				m: 2,
				n: 0.5,
				interest_rate: this.interest_rate,
				fee_multiplier: this.fee_multiplier,
				allow_grants: true,
				oracle1: this.oracleAddress,
				feed_name1: 'GBYTE_USD',
				regular_challenging_period: 5*24*3600,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.network.agent.bsf)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(6)
		for (let name in vars) {
			if (name.startsWith('curve_')) {
				this.curve_aa = name.substr(6)
				expect(vars[name]).to.be.equal("s1^2 s2^0.5")
			}
		}
		this.asset1 = vars['asset_' + this.curve_aa + '_1'];
		this.asset2 = vars['asset_' + this.curve_aa + '_2'];
		this.asset_stable = vars['asset_' + this.curve_aa + '_stable'];
		this.deposit_aa = vars['deposit_aa_' + this.curve_aa];
		this.governance_aa = vars['governance_aa_' + this.curve_aa];

		const { vars: curve_vars } = await this.bob.readAAStateVars(this.curve_aa)
		console.log('curve vars', curve_vars, this.curve_aa)
		expect(curve_vars['asset1']).to.be.equal(this.asset1)
		expect(curve_vars['asset2']).to.be.equal(this.asset2)
		expect(curve_vars['governance_aa']).to.be.equal(this.governance_aa)
		expect(curve_vars['growth_factor']).to.be.equal(1)
		expect(curve_vars['dilution_factor']).to.be.equal(1)
		expect(curve_vars['interest_rate']).to.be.equal(0.1)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(parseInt(curve_vars['rate_update_ts'])).to.be.equal(unitObj.timestamp)

		this.ts = unitObj.timestamp
		this.dilution_factor = 1

		this.getReserve = (s1, s2) => Math.ceil(1e9 * this.dilution_factor * (s1 / 1e9) ** 2 * (s2 / 1e2) ** 0.5)
		this.getP2 = (s1, s2) => this.dilution_factor * (s1/1e9)**2 * 0.5 / (s2/1e2)**0.5
		this.getFee = (avg_reserve, old_distance, new_distance) => Math.ceil(avg_reserve * (new_distance**2 - old_distance**2) * this.fee_multiplier);

		this.buy = (tokens1, tokens2) => {
			const new_supply1 = this.supply1 + tokens1
			const new_supply2 = this.supply2 + tokens2
			const new_reserve = this.getReserve(new_supply1, new_supply2)
			const amount = new_reserve - this.reserve
			const abs_reserve_delta = Math.abs(amount)
			const avg_reserve = (this.reserve + new_reserve)/2
			const p2 = this.getP2(new_supply1, new_supply2)
	
			const old_distance = this.reserve ? Math.abs(this.p2 - this.target_p2) / this.target_p2 : 0
			const new_distance = Math.abs(p2 - this.target_p2) / this.target_p2
			let fee = this.getFee(avg_reserve, old_distance, new_distance);
			if (fee > 0) {
				const reverse_reward = Math.floor((1 - old_distance / new_distance) * this.fast_capacity); // rough approximation
			}

			const fee_percent = round(fee / abs_reserve_delta * 100, 4)
			const reward = old_distance ? Math.floor((1 - new_distance / old_distance) * this.fast_capacity) : 0;
			const reward_percent = round(reward / abs_reserve_delta * 100, 4)

			console.log('p2 =', p2, 'target p2 =', this.target_p2, 'amount =', amount, 'fee =', fee, 'reward =', reward, 'old distance =', old_distance, 'new distance =', new_distance, 'fast capacity =', this.fast_capacity)
	
			this.p2 = p2
			this.distance = new_distance
			if (fee > 0) {
				this.slow_capacity += Math.floor(fee / 2)
				this.fast_capacity += fee - Math.floor(fee / 2)
			}
			else if (reward > 0)
				this.fast_capacity -= reward
			
			if (fee > 0 && reward > 0)
				throw Error("both fee and reward are positive");
			if (fee < 0 && reward < 0)
				throw Error("both fee and reward are negative");
	
			this.supply1 += tokens1
			this.supply2 += tokens2
			this.reserve += amount
	
			return { amount, fee, fee_percent, reward, reward_percent }
		}

		this.supply1 = 0
		this.supply2 = 0
		this.reserve = 0
		this.slow_capacity = 0
		this.fast_capacity = 0
		this.distance = 0
	})


	it('Alice buys tokens', async () => {
		this.target_p2 = 1 / this.price
		
		const tokens1 = 1e9
		const tokens2 = 100e2
		const { amount, fee, fee_percent } = this.buy(tokens1, tokens2)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: amount + 1000,
			data: {
				tokens1: tokens1,
				tokens2: tokens2,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(parseFloat(parseFloat(vars['p2']).toPrecision(13))).to.be.equal(this.p2)
		expect(vars['slow_capacity']).to.be.undefined
		expect(vars['fast_capacity']).to.be.undefined
		expect(vars['lost_peg_ts']).to.be.undefined

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				asset: this.asset1,
				amount: tokens1,
			},
			{
				address: this.aliceAddress,
				asset: this.asset2,
				amount: tokens2,
			},
		])

	})


	it('Half a year later, Bob posts a grant request', async () => {
		const { time_error } = await this.network.timetravel({shift: '180d'})
		expect(time_error).to.be.undefined

		this.grant_amount = this.supply1 * 0.1
		const pledge = "I'm going to do this and that. For my work, I want to be paid " + this.grant_amount + "TOKEN2"

		const { unit, error } = await this.bob.sendMulti({
			messages: [{
				app: 'text',
				payload: pledge
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: unit })
		const textMessage = unitObj.messages.find(m => m.app === 'text')
		expect(textMessage.payload).to.be.equal(pledge)
		await this.network.witnessUntilStable(unit)

		this.grant_request_unit = unit
	})
	
	it('Alice creates a proposal', async () => {
		this.num = 1
		const expiry = '2030-07-01'

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				add_proposal: 1,
				type: 'grant',
				recipient: this.bobAddress,
				amount: this.grant_amount,
				expiry: expiry,
				unit: this.grant_request_unit
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['count_proposals']).to.be.equal(this.num)
		expect(vars['proposal_' + this.num + '_recipient']).to.be.equal(this.bobAddress)
		expect(vars['proposal_' + this.num + '_amount']).to.be.equal(this.grant_amount)
		expect(vars['proposal_' + this.num + '_unit']).to.be.equal(this.grant_request_unit)
		expect(vars['proposal_' + this.num + '_expiry']).to.be.equal(expiry)

		const { unitObj } = await this.alice.getUnitInfo({ unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))

	})

	it('Alice votes for the proposal', async () => {
		const tokens1 = Math.floor(this.supply1 * 0.25)
		const name = 'proposal'
		const value = this.num

		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset1,
			base_outputs: [{ address: this.governance_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.governance_aa, amount: tokens1 }],
			spend_unconfirmed: 'all',
			messages: [{
				app: 'data',
				payload: {
					name: name,
					value: value
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + name + '_' + value]).to.be.equal(tokens1)
		expect(vars['support_' + name + '_' + value + '_' + this.aliceAddress]).to.be.equal(tokens1)
		expect(vars['leader_' + name]).to.be.equal(value)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(tokens1)

		const { unitObj } = await this.alice.getUnitInfo({ unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(vars['challenging_period_start_ts_' + name]).to.be.equal(unitObj.timestamp)

		this.challenging_period_start_ts = unitObj.timestamp
		this.name = name
		this.value = value
		this.tokens1 = tokens1
	})


	it('Bob tries to commit too early but unsuccessful', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				commit: 1,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal('challenging period not expired yet')
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})

	it('Bob waits for 5 days and fails again due to insufficient support', async () => {
		const { time_error } = await this.network.timetravel({shift: '5d'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				commit: 1,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal('not enough support for the proposal')
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})

	it('Alice sends token1 to Charlie', async () => {
		const { unit, error } = await this.alice.sendMulti({
			asset: this.asset1,
			amount: Math.round(this.supply1 * 0.3),
			to_address: this.charlieAddress,
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		await this.network.witnessUntilStable(unit)
	})

	it('Charlie supports Alice and also votes for the proposal', async () => {
		const tokens1 = Math.floor(this.supply1 * 0.3)
		const name = 'proposal'
		const value = this.num

		const { unit, error } = await this.charlie.sendMulti({
			asset: this.asset1,
			base_outputs: [{ address: this.governance_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.governance_aa, amount: tokens1 }],
			spend_unconfirmed: 'all',
			messages: [{
				app: 'data',
				payload: {
					name: name,
					value: value
				}
			}]
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.charlie.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + name + '_' + value]).to.be.equal(0.55 * this.supply1)
		expect(vars['support_' + name + '_' + value + '_' + this.charlieAddress]).to.be.equal(tokens1)
		expect(vars['leader_' + name]).to.be.equal(this.num)
		expect(vars['balance_' + this.charlieAddress]).to.be.equal(tokens1)

		const { unitObj } = await this.charlie.getUnitInfo({ unit })
	//	console.log(JSON.stringify(unitObj, null, '\t'))
		expect(vars['challenging_period_start_ts_' + name]).to.be.equal(this.challenging_period_start_ts)

	})


	it('Bob tries again and commits successfully', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				commit: 1,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + this.name + '_' + this.value]).to.be.equal(this.supply1 * 0.55)
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.supply1 * 0.25)
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.charlieAddress]).to.be.equal(this.supply1 * 0.3)
		expect(vars['leader_' + this.name]).to.be.equal(this.value)
		expect(vars[this.name]).to.be.undefined
		expect(vars['proposal_' + this.num + '_approved']).to.be.equal(1)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(this.supply1 * 0.25)
		expect(vars['balance_' + this.charlieAddress]).to.be.equal(this.supply1 * 0.3)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })

		this.initial_supply1 = this.supply1
		const new_supply1 = this.supply1 + this.grant_amount
		this.dilution_factor = (this.supply1 / new_supply1)**2
		this.supply1 = new_supply1

		const { vars: cvars } = await this.bob.readAAStateVars(this.curve_aa)
		console.log(cvars)
		expect(cvars[this.name]).to.be.undefined
		expect(cvars['rate_update_ts']).to.be.equal(this.ts)
		expect(cvars['growth_factor']).to.be.equal(1)
		expect(cvars['supply1']).to.be.equal(this.supply1)
		expect(cvars['dilution_factor']+'').to.be.equal(this.dilution_factor.toPrecision(15))

	})


	it('Alice tries to withdraw but fails', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				withdraw: 1,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal("support for proposal not removed yet")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})

	it('Alice tries to untie her vote too early but fails', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.equal("you cannot change your vote yet")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})


	it('Alice waits for 30 days and unties her vote successfully', async () => {
		const { time_error } = await this.network.timetravel({shift: '30d'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + this.name + '_' + this.value]).to.be.equal(0.3 * this.initial_supply1) // charlie
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(vars['leader_' + this.name]).to.be.equal(this.value)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(this.tokens1)
		expect(vars[this.name]).to.be.undefined
		expect(vars['proposal_' + this.num + '_approved']).to.be.equal(1)

	})

	it('Alice withdraws successfully', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				withdraw: 1,
			}
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.alice.readAAStateVars(this.governance_aa)
		console.log(vars)
		expect(vars['support_' + this.name + '_' + this.value]).to.be.equal(0.3 * this.initial_supply1) // charlie
		expect(vars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(vars['leader_' + this.name]).to.be.equal(this.value)
		expect(vars['balance_' + this.aliceAddress]).to.be.equal(0)
		expect(vars[this.name]).to.be.undefined
		expect(vars['proposal_' + this.num + '_approved']).to.be.equal(1)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			address: this.aliceAddress,
			asset: this.asset1,
			amount: this.tokens1,
		}])

	})

	it('1 year later, Alice buys more of the tokens2', async () => {
		const { time_error } = await this.network.timetravel({shift: '360d'})
		expect(time_error).to.be.undefined
		this.target_p2 = 1/this.price * 1.1**((180+5+30+360)/360)

		const tokens1 = 0
		const tokens2 = 0.5e2
		const { amount, fee, fee_percent } = this.buy(tokens1, tokens2)

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.curve_aa,
			amount: amount + fee + 1000,
			data: {
				tokens2: tokens2,
			},
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['fee%']).to.be.equal(fee_percent+'%')

		const { vars } = await this.alice.readAAStateVars(this.curve_aa)
		console.log(vars)
		expect(vars['supply1']).to.be.equal(this.supply1)
		expect(vars['supply2']).to.be.equal(this.supply2)
		expect(vars['reserve']).to.be.equal(this.reserve)
		expect(vars['slow_capacity']).to.be.equal(this.slow_capacity)
		expect(vars['fast_capacity']).to.be.equal(this.fast_capacity)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		console.log(JSON.stringify(unitObj, null, '\t'))
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([{
			address: this.aliceAddress,
			asset: this.asset2,
			amount: tokens2,
		}])
		expect(vars['lost_peg_ts']).to.be.equal(unitObj.timestamp)

	})


	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
