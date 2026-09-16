// 前端角色门禁（按现有权限控制方式：admin JWT 里的 role）。
//
// 后端仍是最终闸门：
//   - 全局默认配置（默认配置页）→ 仅超管（provisioning-service 的
//     createSuperAdminMiddleware 对非超管返回 403）；
//   - 一键开通（FDE 版）→ 接口按「后续可直接开放给销售/CSM」设计，
//     本期前端入口只对 FDE 角色可见。
//
// admin_users.role 目前只有 admin / operator（见 credits-ledger
// services/admin-auth.ts）。超管 = admin；FDE 角色（'fde'）需要运维在
// 用户管理里创建——在创建之前，admin 亦可见一键开通入口。

import type { AdminUser } from './api';

export const SUPER_ADMIN_ROLES = ['admin'];

/** 一键开通（FDE 版）可见角色。 */
export const QUICK_START_ROLES = ['admin', 'fde'];

export function hasAnyRole(user: AdminUser | null | undefined, roles: string[]): boolean {
  const role = (user?.role || '').trim();
  return role !== '' && roles.includes(role);
}

export const isSuperAdmin = (user: AdminUser | null | undefined): boolean =>
  hasAnyRole(user, SUPER_ADMIN_ROLES);

export const canQuickStart = (user: AdminUser | null | undefined): boolean =>
  hasAnyRole(user, QUICK_START_ROLES);
