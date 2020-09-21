/* eslint-disable chai-friendly/no-unused-expressions */
// avoid importing `expect` in every test
const chai = require('chai')
const expect = chai.expect
const deepEqualInAnyOrder = require('deep-equal-in-any-order')

global.expect = expect

const { Utils } = require('aa-testkit')

chai.use(deepEqualInAnyOrder)

chai.use((_chai, utils) => {
	chai.Assertion.addProperty('validAddress', function () {
		const address = utils.flag(this, 'object')
		const negate = utils.flag(this, 'negate')
		const check = Utils.isValidAddress(address)
		new chai.Assertion(check).to.be.equal(!negate, !check && `'${JSON.stringify(address)}' is not valid address`)
	})

	chai.Assertion.addProperty('validUnit', function () {
		const unit = utils.flag(this, 'object')
		const negate = utils.flag(this, 'negate')
		const check = Utils.isValidBase64(unit, 44) && unit.endsWith('=')
		new chai.Assertion(check).to.be.equal(!negate, !check && `'${JSON.stringify(unit)}' is not valid unit`)
	})
})
