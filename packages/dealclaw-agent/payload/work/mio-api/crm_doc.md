# Zoho系统重点模块数据字典



#### **Token获取方式**

RefreshToken手册：https://www.zoho.com/crm/developer/docs/api/v8/access-refresh.html

模块权限手册：https://www.zoho.com/crm/developer/docs/api/v2.1/scopes.html



**API请求地址**

https://www.zoho.com/crm/developer/docs/api/v2/get-records.html



**Request URL**

https://www.zohoapis.com/crm/v2/{module_api_name}  
  
**To get specific record:**  
https://www.zohoapis.com/crm/v2/{module_api_name}/{record_id}



样例：

通过数据圈选平台里已有的zohoid直接查客户：

```Plain Text
curl "https://www.zohoapis.com/crm/v2/Accounts/185165006387283225"
-X GET
-H "Authorization: Zoho-oauthtoken 1000.8cb99dxxxxxxxxxxxxx9be93.9b8xxxxxxxxxxxxxxxf"
```

客户模块通过公司名字精准查询：

```Plain Text
curl "https://www.zohoapis.com/crm/v2/Accounts/search?criteria=(Account_Name:equals:广州市欣婷生物科技有限公司)"
-X GET
-H "Authorization: Zoho-oauthtoken 1000.8cb99dxxxxxxxxxxxxx9be93.9b8xxxxxxxxxxxxxxxf"
```

客户模块通过公司名字模糊查询：

```Plain Text
curl "https://www.zohoapis.com/crm/v2/Accounts/search?criteria=(Account_Name:starts_with:广州市欣婷)"
-X GET
-H "Authorization: Zoho-oauthtoken 1000.8cb99dxxxxxxxxxxxxx9be93.9b8xxxxxxxxxxxxxxxf"
```



#### 客户模块

客户样例：Accounts/185165006387283225

<sheet sheet-id="afPi8k" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 联系人

联系人样例：Contacts/185165007711572828

<sheet sheet-id="CmmOPI" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 商机

<sheet sheet-id="u94Fv8" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

![图片展示的是Zoho系统中关于2025年第十届中国（印尼）出口品牌联展的商机页面。页面上方有“发送邮件”“编辑”“更新展区”等操作按钮。下方商机管道显示从“初步意向”到“赢单关闭”的各阶段，当前处于“谈判”阶段。页面右上角显示上次更新时间为16:21。该图片与文档中介绍Zoho系统重点模块数据字典 - 商机的内容相关，直观呈现了商机在系统中的状态流转情况。](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZTg3OTZkODc5NjhkY2U3NGQwY2M0MzY3MDE3NmQwYzVfMmFiYTQ1Y2EwNGMwZmM0OGZhNTkwNjY5NjIwYWYwNmFfSUQ6NzY1NTYxODEyNDA0Mjg5ODM4Ml8xNzgyNDcxNjk5OjE3ODI0NzUyOTlfVjM)

#### 合同

<sheet sheet-id="MTAJ8t" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 会议

<sheet sheet-id="IWELKe" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 通话

<sheet sheet-id="OxbHsY" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 展会

<sheet sheet-id="JfIuUn" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 展区

<sheet sheet-id="2Glz1E" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 产品标签

<sheet sheet-id="S53fjm" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 客户产品标签

<sheet sheet-id="xKTCdt" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 资料来源

<sheet sheet-id="8au7gt" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>

#### 客户资料来源

<sheet sheet-id="oF8QXs" token="GeUcsOt3VhyEnTtsKOfcZO1Vni7"></sheet>



<source href="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=MjgyZmZkODk0ZmVjZTBlMGIxODg0NzAxNGFkM2ZjNjlfZWMyODc5ZTE4Y2UwYzIwMDVhNmE1NzZmMjcyNWEzODhfSUQ6NzY1NTYxNTg1ODk3MTIwMDQ4Nl8xNzgyNDcxNjk5OjE3ODI0NzUyOTlfVjM" mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" token="ISbFb5978oBidjx04sRc9ZaKnqb"/>