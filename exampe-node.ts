import { Request, Response } from 'express';
import { IPatient } from '../interfaces';
import { NoteService, UserService, PatientService } from '../services';
import {
    DqUser,
    Patient,
    PatientGeneralInfo,
    FollowUps,
    PatientMedicalInfo,
    PatientPDBInfo,
    Eligibility,
    PatientFamily,
    User
} from '../models/psql_models';
import { Op } from 'sequelize';
import axios, { AxiosRequestConfig } from 'axios';
import * as azure from 'azure-storage';
import { v1 } from 'uuid';

const queueSvc = azure.createQueueService(`${process.env.AZURE_STORAGE_ACCOUNT_NAME}`,
    `${process.env.AZURE_STORAGE_ACCOUNT_ACCESS_KEY}`);
queueSvc.messageEncoder = new azure.QueueMessageEncoder.TextBase64QueueMessageEncoder();

export class PatientController {

    public async getEligibilityInformation(req: Request, res: Response) {
        try {
            const {id} = req.query;
            const eligibility = await Eligibility.findAll({where: {patient_id: id}}) as Eligibility;
            return res.json({data: eligibility});
        } catch (err) {
            console.error(err);
            return res.status(400).json({error: err});
        }
    }

    public async getPatientDetails(req: Request, res: Response) {
        try {
            const {practice, page, filter, fieldFilter, filterBy, sortBy, typeSort, perPage} = req.query;
            const past60 = new Date(new Date().setDate(new Date().getDate() - 60));
            const past180 = new Date(new Date().setDate(new Date().getDate() - 180));
            const past365 = new Date(new Date().setDate(new Date().getDate() - 365));
            const query: any = {};
            const queryGeneralInfo: any = {};
            const queryMedicalInfo: any = {};
            const statusPatient = {
                [Op.and]: [
                    {contact_status: {[Op.notRegexp]: 'Do Not Contact'}},
                    {contact_status: {[Op.notRegexp]: 'Changed Dentists'}},
                    {contact_status: {[Op.notRegexp]: 'Moved Away'}},
                    {contact_status: {[Op.notRegexp]: 'Placed on Books!'}},
                    {contact_status: {[Op.notRegexp]: 'Already Scheduled'}},
                ]
            };
            let order: any;
            const sort = typeSort === '1' ? 'ASC' : typeSort === '-1' ? 'DESC' : '';
            if (sortBy) {
                if (sortBy === 'lname' || sortBy === 'fname' || sortBy === 'dob') {
                    order = {order: [[PatientGeneralInfo, sortBy, sort]]};
                } else if (sortBy === 'insurance') {
                    order = {order: [[PatientMedicalInfo, sortBy, sort]]};
                } else if (sortBy === 'last_service_date_pdb' || sortBy === 'total_visits') {
                    order = {order: [[PatientPDBInfo, sortBy, sort]]};
                } else {
                    order = {order: [[sortBy, sort]]};
                }
            }
            if (fieldFilter) {
                if (fieldFilter === 'lname' || fieldFilter === 'fname' || fieldFilter === 'dob') {
                    queryGeneralInfo[fieldFilter] = {[Op.regexp]: filterBy};
                } else if (fieldFilter === 'insurance') {
                    queryMedicalInfo[fieldFilter] = {[Op.regexp]: filterBy};
                } else {
                    query[fieldFilter] = {[Op.regexp]: filterBy};
                }
            }
            if (!filter) {
                const countPatients = await Patient.count({
                    where: {...query, practice_id: practice},
                    include: [{model: PatientGeneralInfo, where: {...queryGeneralInfo}}]
                });
                const patients = await Patient.findAll({
                    where: {...query, practice_id: practice},
                    offset: ((perPage * page) - perPage),
                    limit: perPage,
                    include: [
                        {model: PatientGeneralInfo, where: {...queryGeneralInfo}},
                        {model: PatientMedicalInfo, where: {...queryMedicalInfo}},
                        PatientPDBInfo],
                    ...order
                }) as Patient[];
                if (!patients) {
                    return;
                }
                const patientsWithFollowUp: IPatient[] = [];
                await Promise.all(patients.map(async (patient: any) => {
                        const firstFollowUp = await FollowUps.findOne({
                            include: [{model: Patient, where: {id: patient.id}}],
                            where: {status: 'Pending'},
                            order: [['due_date', 'ASC']],
                        }) as FollowUps;
                        if (!firstFollowUp) {
                            patient.dataValues.followUpDate = '';
                            patient.dataValues.followedUp = false;
                            patientsWithFollowUp.push(patient);
                            return;
                        }
                        patient.dataValues.followUpDate = firstFollowUp.due_date;
                        patient.dataValues.followedUp = true;
                        patientsWithFollowUp.push(patient);
                    })
                );
                return res.json({patients: patientsWithFollowUp, countPatients});
            }
            let code: any;
            let condition: any;
            switch (filter) {
                case 'new_to_roster':
                    code = {
                        '$patient_general_info.subscriber_id$': {[Op.ne]: null},
                        '$patient_general_info.mco_status$': false || null,
                        insert_date: {[Op.gt]: past60}
                    };
                    break;
                case 'no_visit':
                    condition = {
                        last_service_date: null,
                        '$patient_pdb_info.last_service_date_pdb$': null,
                        '$patient_pdb_info.last_prophylaxis_date_pdb$': null
                    };
                    code = {
                        [Op.or]: [{
                            '$patient_general_info.mco_status$': true,
                            ...condition
                        }, {
                            [Op.or]: [{website: {[Op.ne]: 'dentaquest'}}, {website: {[Op.ne]: 'mcna'}}],
                            ...condition
                        }],
                    };
                    break;
                case 'unscheduled':
                    condition = {
                        '$patient_pdb_info.tx_planned$': {[Op.gt]: 0},
                        next_service: null
                    };
                    code = {
                        [Op.or]: [{
                            '$patient_general_info.mco_status$': true,
                            ...condition
                        }, {
                            [Op.or]: [{website: {[Op.ne]: 'dentaquest'}}, {website: {[Op.ne]: 'mcna'}}],
                            ...condition
                        }]
                    };
                    break;
                case 'overdue':
                    condition = {
                        [Op.or]:
                            [
                                [{
                                    '$patient_pdb_info.last_service_date_pdb$': {[Op.gt]: past365, [Op.lt]: past180},
                                    last_service_date: {[Op.lt]: past180},
                                }],
                                [{
                                    last_service_date: {[Op.gt]: past365, [Op.lt]: past180},
                                    '$patient_pdb_info.last_service_date_pdb$': {[Op.lt]: past180},
                                }]]
                    };
                    code = {
                        [Op.or]: [{
                            '$patient_general_info.mco_status$': true,
                            ...condition
                        }, {
                            [Op.or]: [{website: {[Op.ne]: 'dentaquest'}}, {website: {[Op.ne]: 'mcna'}}],
                            ...condition
                        }]
                    };
                    break;
                case 'inactive':
                    condition = {
                        next_service: null,
                        [Op.and]: [
                            {
                                [Op.or]: [
                                    {last_service_date: {[Op.lt]: past365}},
                                    {'$patient_pdb_info.last_service_date_pdb$': {[Op.lt]: past365}}]
                            },
                            {
                                [Op.or]: [
                                    {
                                        '$patient_pdb_info.last_prophylaxis_date_pdb$': {[Op.ne]: null},
                                        '$patient_pdb_info.last_service_date_pdb$': {[Op.ne]: null},
                                    },
                                ],
                            },
                        ],
                    };
                    code = {
                        [Op.or]: [{
                            '$patient_general_info.mco_status$': true,
                            ...condition
                        }, {
                            [Op.or]: [{website: {[Op.ne]: 'dentaquest'}}, {website: {[Op.ne]: 'mcna'}}],
                            ...condition
                        }]
                    };
                    break;
                case 'no show\'d':
                    code = {
                        '$patient_general_info.mco_status$': true,
                        [Op.and]: [
                            {next_service: {[Op.lt]: new Date()}},
                            {next_service: {[Op.gt]: {[Op.col]: 'last_touch'}}}
                        ],
                    };
                    break;
                case 'scheduled_today':
                    code = {
                        next_service: {[Op.between]: [new Date(new Date().setDate(new Date().getDate() + 1)), new Date()]}
                    };
                    break;
                case 'existing_in_another_practices':
                    code = {
                        '$patient_general_info.multipractice$': true,
                    };
                    break;
            }
            const countPatients = await Patient.count({
                include: [{
                    model: PatientGeneralInfo, where: {
                        ...statusPatient
                    }
                }, {model: PatientPDBInfo}],
                where: {...code, practice_id: practice}
            });
            const sortPatient = await Patient.findAll({
                offset: ((perPage * page) - perPage),
                limit: perPage,
                include: [
                    {model: PatientGeneralInfo},
                    {model: PatientMedicalInfo, where: {...queryMedicalInfo}},
                    {model: PatientPDBInfo}],
                where: {...code, practice_id: practice},
                ...order
            }) as Patient[];
            if (!sortPatient) {
                return;
            }
            const sortPatientsWithFollowUp: IPatient[] = [];
            await Promise.all(sortPatient.map(async (patient: any) => {
                    const firstFollowUp = await FollowUps.findOne({
                        where: {status: 'Pending', patient_id: patient.id},
                        order: [['due_date', 'ASC']],
                    }) as FollowUps;
                    if (!firstFollowUp) {
                        patient.dataValues.followUpDate = '';
                        patient.dataValues.followedUp = false;
                        sortPatientsWithFollowUp.push(patient);
                        return;
                    }
                    patient.dataValues.followUpDate = firstFollowUp.due_date;
                    patient.dataValues.followedUp = true;
                    sortPatientsWithFollowUp.push(patient);
                })
            );
            return res.json({patients: sortPatientsWithFollowUp, countPatients});
        } catch (err) {
            console.error(err);
            return res.status(400).json({error: err});
        }
    }

    public async followUpPatient(req: Request, res: Response) {
        try {
            const {patient_id, date, assignee, description} = req.body;
            const {headers: {authorization}} = req;
            const author = await UserService.getInfoFromToken(authorization, 'id');
            const user: any | null = await User.findOne({where: {id: author}});
            await FollowUps.create({
                patient_id: patient_id,
                author: author,
                assignee: assignee,
                created_at: new Date(),
                due_date: date,
                description: description,
                status: 'Pending',
            });
            await NoteService.createNote(patient_id, user.username, 'Follow UP created');
            return res.json({message: 'Patient followed successful!'});
        } catch (err) {
            console.error(err);
            return res.status(400).json({error: err});
        }
    }

    public async getPatientByPractice(req: Request, res: Response) {
        try {
            const {practice_id, filter} = req.params;
            const patients = await Patient.findAll({
                where: {practice_id},
                attributes: ['id'],
                include: [{
                    model: PatientGeneralInfo,
                    where: {
                        [Op.or]: [
                            {lname: {[Op.iRegexp]: filter}},
                            {fname: {[Op.iRegexp]: filter}},
                        ]
                    },
                    attributes: ['fname', 'lname']
                }]
            }) as Patient[];
            return res.json({patients: patients});
        } catch (err) {
            console.error(err);
            return res.status(400).json({error: err});
        }
    }

    public async syncPatientFiles(req: Request, res: Response) {
        try {
            const {patients, company, practice} = req.body;
            const mcnaPatient: Array<any> = [];
            const dqPatient: Array<any> = [];
            patients.forEach((patient: any) => {
                if (patient.website === 'mcna') {
                    mcnaPatient.push(patient);
                } else if (patient.website === 'dentaquest') {
                    dqPatient.push(patient);
                }
            });

            if (mcnaPatient.length) {
                const website: string = 'mcna';
                const uniqueFids: any = new Set();
                mcnaPatient.forEach((patient) => {
                    uniqueFids.add(patient.facility_id);
                });
                uniqueFids.forEach(async (fid: string) => {
                    const creds: any = await PatientService.getUserCreds(company, practice, website, fid);
                    const username = creds.username ? creds : null;
                    if (creds) {
                        const user = await DqUser.findOne({where: {username: creds.username, status: 'Valid'}});
                        if (!user) {
                            return res.status(400).json({
                                error: `Please validate user credentials first for ${username} from company ${company}!`
                            });
                        }
                    } else {
                        return res.status(400).json({error: `User ${username} not found for company ${company}`});
                    }
                    const jobid = v1();
                    creds.jobid = jobid;
                    const options: AxiosRequestConfig = {
                        method: 'POST',
                        url: 'https://xxxxxarrowfunctions.azurewebsites.net/api/AddInfoToRequestQueue?code=xxxxxxxxxxx',
                        responseType: 'json',
                        data: {
                            creds, website, jobid, patients,
                            project: 'medical_scraper',
                            spider: 'mcna',
                            scrape_mode: 'partial',
                        }
                    };
                    return await axios(options);
                });

            }

            if (dqPatient.length) {
                const website = 'dentaquest';
                dqPatient.forEach((patient, e) => {
                    if (patient.fid || patient.fid === '') {
                        delete dqPatient[e].fid;
                    }
                });
                const creds: any = await PatientService.getUserCreds(company, practice, website);
                const username = creds.username ? creds : null;
                if (creds) {
                    const user = await DqUser.findOne({where: {username: creds.username, status: 'Valid'}});
                    if (!user) {
                        return res.status(400).json({
                            error: `Please validate user credentials first for ${username} from company ${company}!`
                        });
                    }
                } else {
                    return res.status(400).json({error: `User ${username} not found for company ${company}`});
                }
                const jobid = v1();
                creds.jobid = jobid;
                const options: AxiosRequestConfig = {
                    method: 'POST',
                    url: 'https://xxxxxxxxxxarrowfunctions.azurewebsites.net/api/AddInfoToRequestQueue?code=Txxxxxxxxxxxxx',
                    responseType: 'json',
                    data: {
                        creds, website, jobid, patients,
                        project: 'medical_scraper',
                        spider: 'mcna',
                        scrape_mode: 'partial',
                    }
                };
                await axios(options);
            }
            return res.json({message: 'Sync patient files successful!'});
        } catch (err) {
            console.error(err);
            return res.status(400).json({error: err});
        }
    }

    public async getFamilyMembers(req: Request, res: Response) {
        try {
            const {id} = req.params;
            const familyMembersForGuarantor = await PatientFamily.findAll({
                where: {guarantor_id: id},
                include: [{model: Patient, include: [PatientGeneralInfo]}]
            }) as PatientFamily[];
            if (familyMembersForGuarantor.length) {
                return res.json({familyMembers: familyMembersForGuarantor});
            }
            const guarantor = await PatientFamily.findOne({
                where: {patient_id: id},
                include: [{model: Patient, include: [PatientGeneralInfo]}]
            }) as PatientFamily;
            if (!guarantor) {
                return res.json({familyMembers: []});
            }
            const familyMembersForPatient = await PatientFamily.findAll({
                where: {guarantor_id: guarantor.guarantor_id},
                include: [{model: Patient, where: {id: {[Op.ne]: id}}, include: [PatientGeneralInfo]}]
            }) as PatientFamily[];
            return res.json({familyMembers: familyMembersForPatient.length ? [...familyMembersForPatient, guarantor] : [guarantor]});
        } catch (err) {
            console.error(err);
            return res.status(400).json({error: err});
        }
    }
}
