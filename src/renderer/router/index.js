import Vue from '../modules/vue/index';
import Router from '../modules/vue-router/index';

Vue.use(Router);

export default new Router({
    routes: [
        {
            path: '/',
            name: 'vlan-page',
            component: require('@/pages/home.vue').default,
        },
        {
            path: '*',
            redirect: '/',
        },
    ],
});
