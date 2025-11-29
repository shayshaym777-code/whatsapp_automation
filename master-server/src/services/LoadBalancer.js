const axios = require('axios');

const workers = [
    {
        id: 'worker-1',
        country: 'US',
        url: process.env.WORKER_US_URL || 'http://worker-1:3000'
    },
    {
        id: 'worker-2',
        country: 'IL',
        url: process.env.WORKER_IL_URL || 'http://worker-2:3000'
    },
    {
        id: 'worker-3',
        country: 'GB',
        url: process.env.WORKER_GB_URL || 'http://worker-3:3000'
    }
];

class LoadBalancer {
    constructor() {
        this.roundRobinIndex = {};
    }

    getWorkers() {
        return workers;
    }

    getCountryFromPhone(phone) {
        if (!phone) return 'US';
        const clean = String(phone).replace(/[\s\-()]/g, '');

        if (clean.startsWith('+972')) return 'IL';
        if (clean.startsWith('+1')) return 'US';
        if (clean.startsWith('+44')) return 'GB';

        return 'US';
    }

    selectWorkerForPhone(phone) {
        const country = this.getCountryFromPhone(phone);
        const available = workers.filter(w => w.country === country);
        const list = available.length > 0 ? available : workers;

        const key = available.length > 0 ? country : 'DEFAULT';
        const current = this.roundRobinIndex[key] || 0;

        const worker = list[current % list.length];
        this.roundRobinIndex[key] = current + 1;
        return worker;
    }

    async sendToWorker(message) {
        const worker = this.selectWorkerForPhone(message.fromPhone);
        const payload = {
            from_phone: message.fromPhone,
            to_phone: message.toPhone,
            message: message.message
        };

        const response = await axios.post(`${worker.url}/send`, payload);

        return {
            workerId: worker.id,
            workerCountry: worker.country,
            response: response.data
        };
    }
}

module.exports = new LoadBalancer();
